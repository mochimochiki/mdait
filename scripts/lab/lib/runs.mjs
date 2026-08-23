/*
 * 実行の記録。
 *
 * 1回の `lab up` に1つの run ディレクトリを作り、以後の手順をそこへ積む。
 * 全文はディスク、画面には要約だけ、という分担をここで守る。
 */
import fs from "node:fs";
import path from "node:path";
import { LAB_DIR, ensureLabDir, readSession } from "./session.mjs";
import { census, diffCensus, renderDigest } from "./digest.mjs";

/** run の置き場 */
export const RUNS_DIR = path.join(LAB_DIR, "runs");
/** いちばん新しい run への近道 */
export const LATEST_LINK = path.join(LAB_DIR, "latest");

function stamp(date = new Date()) {
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** `latest` を張り替える。張れない環境（symlink 不可）では場所を書いた紙で代える */
function linkLatest(runDir) {
	try {
		fs.rmSync(LATEST_LINK, { recursive: true, force: true });
		fs.symlinkSync(runDir, LATEST_LINK, "dir");
	} catch {
		try {
			fs.writeFileSync(`${LATEST_LINK}.txt`, `${runDir}\n`, "utf8");
		} catch {}
	}
}

/**
 * run ディレクトリを作る。
 * @param {string} name 何のための run か（ディレクトリ名の後ろに付く）
 * @returns {{runDir: string, seq: number}}
 */
export function createRun(name = "run") {
	ensureLabDir();
	const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, "-");
	let runDir = path.join(RUNS_DIR, `${stamp()}-${safe}`);
	// 同じ秒に2つ作られたときのために番号を足す
	let suffix = 1;
	while (fs.existsSync(runDir)) {
		runDir = path.join(RUNS_DIR, `${stamp()}-${safe}-${suffix}`);
		suffix += 1;
	}
	for (const sub of ["steps", "shots", "ai", "census"]) {
		fs.mkdirSync(path.join(runDir, sub), { recursive: true });
	}
	linkLatest(runDir);
	return { runDir, seq: 0 };
}

/** 今の run ディレクトリを返す（セッションに書かれているもの） */
export function currentRunDir() {
	const session = readSession();
	return session?.runDir && fs.existsSync(session.runDir) ? session.runDir : null;
}

function censusDir(runDir) {
	return path.join(runDir, "census");
}

/** 最後に取った棚卸しを読む。無ければ null */
function lastCensus(runDir) {
	let names;
	try {
		names = fs.readdirSync(censusDir(runDir)).filter((n) => n.endsWith(".json"));
	} catch {
		return null;
	}
	if (names.length === 0) return null;
	names.sort();
	try {
		return JSON.parse(fs.readFileSync(path.join(censusDir(runDir), names[names.length - 1]), "utf8"));
	} catch {
		return null;
	}
}

/**
 * 最初の1手順のために、始める前の姿を控えておく。
 * @param {string} runDir
 * @param {string} ws
 */
export function snapshotBaseline(runDir, ws) {
	fs.mkdirSync(censusDir(runDir), { recursive: true });
	fs.writeFileSync(path.join(censusDir(runDir), "000-baseline.json"), `${JSON.stringify(census(ws), null, 2)}\n`, "utf8");
}

/** 次の連番を決める。既にある手順の数＋1 */
function nextSeq(runDir) {
	let names;
	try {
		names = fs.readdirSync(path.join(runDir, "steps"));
	} catch {
		return 1;
	}
	const numbers = names.map((n) => Number.parseInt(n.slice(0, 3), 10)).filter((n) => Number.isFinite(n));
	return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/**
 * 1手順ぶんを保存する。全文の JSON と、画面に出す要約（digest）の2つを書く。
 *
 * @param {string} runDir
 * @param {string} command 実行したコマンド名
 * @param {object} result result.json の中身
 * @param {{args?: unknown[], ws?: string}} extra
 * @returns {{jsonPath: string, digestPath: string, seq: number, digest: string}}
 */
export function saveStep(runDir, command, result, extra = {}) {
	const seq = nextSeq(runDir);
	const label = String(seq).padStart(3, "0");
	const stepsDir = path.join(runDir, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });

	const jsonPath = path.join(stepsDir, `${label}-${command}.json`);
	fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

	const ws = extra.ws ?? readSession()?.ws;
	let diff = ["（ワークスペースが分からないので差は出せません）"];
	if (ws && fs.existsSync(ws)) {
		const before = lastCensus(runDir);
		const after = census(ws);
		fs.mkdirSync(censusDir(runDir), { recursive: true });
		fs.writeFileSync(path.join(censusDir(runDir), `${label}.json`), `${JSON.stringify(after, null, 2)}\n`, "utf8");
		diff = diffCensus(before, after);
	}

	const digest = renderDigest({ seq, command, args: extra.args, result, diff, jsonPath });
	const digestPath = path.join(stepsDir, `${label}-${command}.digest.md`);
	fs.writeFileSync(digestPath, digest, "utf8");
	return { jsonPath, digestPath, seq, digest };
}

/**
 * run ディレクトリの中身から report.md を組み立てる。
 * @returns {string} report.md のパス
 */
export function buildReport(runDir) {
	const lines = ["# 実行の記録", ""];
	const snapshot = path.join(runDir, "session.json");
	if (fs.existsSync(snapshot)) {
		try {
			const s = JSON.parse(fs.readFileSync(snapshot, "utf8"));
			lines.push(`- ホスト: ${s.host}`, `- 作業場: ${s.ws}`, `- AI 役: ${s.ai?.mode ?? "none"}`, `- 開始: ${s.startedAt}`);
		} catch {
			lines.push("- （起動時の設定が読めませんでした）");
		}
		lines.push("");
	}
	let names = [];
	try {
		names = fs
			.readdirSync(path.join(runDir, "steps"))
			.filter((n) => n.endsWith(".digest.md"))
			.sort();
	} catch {}
	if (names.length === 0) {
		lines.push("手順はまだありません。");
	}
	for (const name of names) {
		lines.push(fs.readFileSync(path.join(runDir, "steps", name), "utf8").trimEnd(), "");
	}
	let shots = [];
	try {
		shots = fs.readdirSync(path.join(runDir, "shots")).sort();
	} catch {}
	if (shots.length > 0) {
		lines.push("## 画面の写し", "");
		for (const shot of shots) lines.push(`- ${path.join(runDir, "shots", shot)}`);
		lines.push("");
	}
	const reportPath = path.join(runDir, "report.md");
	fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
	return reportPath;
}
