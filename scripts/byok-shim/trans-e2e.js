/*
 * mdait の trans を、shim を相手に実際に走らせる（VS Code なし）。
 *
 * scripts/exploratory/vscode-shim.js が用意する vscode モックの上で、コンパイル済みの
 * commands 層をそのまま呼ぶ。違いは1つだけで、fake-ai.js を読み込まない。
 * つまり AIServiceBuilder は本物の OpenAIProvider を作り、HTTP で shim を叩く。
 *
 *   node scripts/byok-shim/shim.mjs --mode agent --port 8080 &
 *   npm run compile
 *   node scripts/byok-shim/trans-e2e.js --shim http://127.0.0.1:8080/v1
 *
 * テスト用ワークスペースの mdait.json を書き換えるが、終了時に必ず元へ戻す。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { vscode, REPO, WS } = require("../exploratory/vscode-shim");

const CFG_PATH = path.join(WS, ".mdait/mdait.json");
const CONTENT = path.join(WS, "content");

// AI の初回利用ダイアログを踏まないようにする（GUI が無いので答えられない）
process.env.MDAIT_DEBUG_IPC = "1";

function parseArgs(argv) {
	const options = {
		shim: "http://127.0.0.1:8080/v1",
		targets: [],
		model: "byok-shim",
		timeoutSec: 600,
		keep: false,
		concurrency: undefined,
	};
	for (let at = 0; at < argv.length; at += 1) {
		const flag = argv[at];
		if (flag === "--shim") options.shim = argv[++at];
		else if (flag === "--dir") options.dir = argv[++at];
		else if (flag === "--target") options.targets.push(argv[++at]);
		else if (flag === "--model") options.model = argv[++at];
		else if (flag === "--timeout") options.timeoutSec = Number(argv[++at]);
		else if (flag === "--concurrency") options.concurrency = Number(argv[++at]);
		else if (flag === "--keep") options.keep = true;
		else if (flag === "-h" || flag === "--help") {
			process.stdout.write(
				"node scripts/byok-shim/trans-e2e.js [--shim URL] [--target 相対パス]... [--dir 相対ディレクトリ] [--model 名前] [--timeout 秒] [--concurrency 数] [--keep]\n",
			);
			process.exit(0);
		} else {
			process.stderr.write(`知らないオプションです: ${flag}\n`);
			process.exit(2);
		}
	}
	if (options.targets.length === 0 && !options.dir) options.targets = ["en/10_test.md"];
	return options;
}

/** マーカー行と need フラグを読む（run-sweep.js と同じ見方） */
const MARKER = /<!--\s*mdait\s+([0-9a-f]{8})(?:\s+from:([0-9a-f]{8}))?(?:\s+need:([^\s>]+))?\s*-->/g;
function needCounts(content) {
	const counts = {};
	for (const match of content.matchAll(MARKER)) {
		const need = match[3] || "-";
		counts[need] = (counts[need] || 0) + 1;
	}
	return counts;
}

/** ディレクトリ以下の、まだ訳していないファイルを集める */
function collectPendingTargets(root) {
	const found = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(md|txt|csv|json)$/.test(entry.name)) {
				const counts = needCounts(fs.readFileSync(full, "utf8"));
				if (counts.translate || counts.revise) found.push(full);
			}
		}
	};
	if (fs.existsSync(root)) walk(root);
	return found;
}

/** shim の覗き窓を読む（同時に何本走ったかを外から確かめる） */
async function readShimStats(baseUrl) {
	try {
		const response = await fetch(`${new URL(baseUrl).origin}/__shim/stats`);
		return await response.json();
	} catch (error) {
		return { error: error.message };
	}
}

/**
 * ディレクトリ翻訳と同じ経路を通す。
 * 本物のツリー操作は transFile_CoreProc を runWithConcurrency に載せるので、ここも同じにする。
 */
async function translateDirectory(options, root) {
	const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
	const { clampConcurrency, runWithConcurrency } = require(path.join(REPO, "out/commands/shared/concurrency.js"));
	const { transFile_CoreProc } = require(path.join(REPO, "out/commands/trans/trans-command.js"));

	const files = collectPendingTargets(root);
	const concurrency = clampConcurrency(Configuration.getInstance().trans.concurrency);
	console.log(`\n=== ディレクトリ翻訳 ===`);
	console.log(`  対象: ${files.length} ファイル / trans.concurrency = ${concurrency}`);
	if (files.length === 0) return;

	const progress = { report: () => {} };
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };

	const started = Date.now();
	const results = await runWithConcurrency(files, concurrency, async (file) => {
		try {
			return await transFile_CoreProc(vscode.Uri.file(file), progress, token);
		} catch (error) {
			return { outcome: "error", message: error.message };
		}
	});
	const elapsed = Date.now() - started;

	for (const [index, result] of results.entries()) {
		const relative = path.relative(CONTENT, files[index]);
		const after = needCounts(fs.readFileSync(files[index], "utf8"));
		console.log(`  ${relative}: ${JSON.stringify(result)} / 残った need: ${JSON.stringify(after)}`);
	}
	console.log(`  合計 ${(elapsed / 1000).toFixed(1)} 秒`);
	console.log(`  shim が見た同時実行: ${JSON.stringify(await readShimStats(options.shim))}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const backup = fs.readFileSync(CFG_PATH);

	try {
		execSync("npm run copy-test-files", { cwd: REPO, stdio: "ignore" });
		for (const name of ["unit-state", "unit-registry"]) {
			const stale = path.join(WS, ".mdait", name);
			if (fs.existsSync(stale)) fs.rmSync(stale);
		}

		const config = JSON.parse(backup.toString("utf8"));
		config.ai = {
			provider: "openai",
			model: options.model,
			openai: {
				// shim は認証を検証しないが、mdait は空だと構築時に落ちるのでダミーを置く
				apiKey: "byok-shim-does-not-check-this",
				baseURL: options.shim,
				timeoutSec: options.timeoutSec,
			},
			debug: { enableStatsLogging: true, logPromptAndResponse: true },
		};
		if (options.concurrency !== undefined) {
			config.trans = Object.assign({}, config.trans, { concurrency: options.concurrency });
		}
		fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2));

		const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
		await Configuration.getInstance().load();
		const { SelectionState } = require(path.join(REPO, "out/core/status/selection-state.js"));
		const selection = SelectionState.getInstance();
		selection.updateSelection(selection.getSelectableTargets().map((target) => target.key));

		const { syncCommand } = require(path.join(REPO, "out/commands/sync/sync-command.js"));
		const { transCommand } = require(path.join(REPO, "out/commands/trans/trans-command.js"));

		console.log(`相手: ${options.shim}`);
		console.log("sync で need:translate を立てます…");
		await syncCommand();

		if (options.dir) {
			await translateDirectory(options, path.join(CONTENT, options.dir));
		}

		for (const relative of options.targets) {
			const file = path.join(CONTENT, relative);
			if (!fs.existsSync(file)) {
				console.log(`× ${relative}: sync 後にも存在しません`);
				continue;
			}
			const before = needCounts(fs.readFileSync(file, "utf8"));
			const started = Date.now();
			let result;
			let failure;
			try {
				result = await transCommand(vscode.Uri.file(file));
			} catch (error) {
				failure = error;
			}
			const elapsed = Date.now() - started;
			const after = needCounts(fs.readFileSync(file, "utf8"));

			console.log(`\n--- ${relative} ---`);
			console.log(`  trans 前の need: ${JSON.stringify(before)}`);
			console.log(`  trans 後の need: ${JSON.stringify(after)}`);
			console.log(`  かかった時間: ${(elapsed / 1000).toFixed(1)} 秒`);
			if (failure) console.log(`  例外: ${failure.message}`);
			else console.log(`  結果: ${JSON.stringify(result)}`);
			console.log("  訳文の冒頭:");
			console.log(
				fs
					.readFileSync(file, "utf8")
					.split("\n")
					.slice(0, 24)
					.map((line) => `    ${line}`)
					.join("\n"),
			);
		}

		const statsLog = path.join(WS, ".mdait/logs/ai-stats.log");
		if (fs.existsSync(statsLog)) {
			console.log("\n--- ai-stats.log ---");
			console.log(fs.readFileSync(statsLog, "utf8").trim().split("\n").slice(-12).join("\n"));
		}
	} finally {
		if (!options.keep) fs.writeFileSync(CFG_PATH, backup);
	}
}

main()
	.then(() => {
		// commands 層はタイマーや watcher を残すので、待っていても終わらない。
		// 明示的に降りる（run-sweep.js と同じ扱い）
		process.exit(0);
	})
	.catch((error) => {
		console.error("E2E ERROR:", error?.stack || error);
		process.exit(1);
	});
