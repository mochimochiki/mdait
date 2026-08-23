#!/usr/bin/env node
/*
 * 録音した実機の往復を、そのまま無人で再現する回帰テスト。
 *
 * recordings/trans-en-child.jsonl は、翻訳役に claude を据えて実際に走らせたときの
 * 12往復をそのまま録ったもの。ここではその録音を相手に mdait の trans を走らせ、
 * 同じ結果になることを確かめる。LLM は1回も呼ばないので、費用も鍵も要らない。
 *
 *   npm run test:byok:e2e
 *
 * 要求が録音と1文字でも違えば shim が 409 を返し、このテストは落ちる。
 * つまりプロンプトの組み立てが変わったことに、ここで気づける。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDING = path.join(HERE, "recordings", "trans-en-child.jsonl");
const EXPECTED = [
	{ file: "en/child/child2/child2_1.md", units: 5 },
	{ file: "en/child/child2/child2_2.md", units: 2 },
	{ file: "en/child/child_ja_new.md", units: 2 },
];

/** shim を立てて、実ポートが分かるまで待つ */
function startShim() {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[path.join(HERE, "shim.mjs"), "--mode", "replay", "--replay", RECORDING, "--port", "0", "--quiet"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (buffer) => {
			stdout += buffer.toString();
			const match = /^PORT=(\d+)/m.exec(stdout);
			if (match) resolve({ child, port: Number(match[1]) });
		});
		child.stderr.on("data", (buffer) => {
			stderr += buffer.toString();
		});
		child.on("exit", (code) => reject(new Error(`shim が起動しませんでした（終了コード ${code}）: ${stderr}`)));
	});
}

function runDriver(port) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				path.join(HERE, "trans-e2e.js"),
				"--shim",
				`http://127.0.0.1:${port}/v1`,
				"--dir",
				"en/child",
				"--concurrency",
				"4",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", (buffer) => {
			output += buffer.toString();
		});
		child.stderr.on("data", (buffer) => {
			output += buffer.toString();
		});
		child.on("close", (code) => resolve({ code, output }));
	});
}

const problems = [];

const { child, port } = await startShim();
try {
	const { code, output } = await runDriver(port);
	if (code !== 0) problems.push(`trans-e2e.js が終了コード ${code} で落ちました`);

	for (const expected of EXPECTED) {
		const line = output.split("\n").find((row) => row.includes(expected.file));
		if (!line) {
			problems.push(`${expected.file} の結果が出力にありません`);
			continue;
		}
		if (!line.includes(`"translatedCount":${expected.units}`)) {
			problems.push(`${expected.file}: 訳した数が ${expected.units} ではありません → ${line.trim()}`);
		}
		if (!line.includes('残った need: {"-"')) {
			problems.push(`${expected.file}: need が残っています → ${line.trim()}`);
		}
	}

	const stats = await (await fetch(`http://127.0.0.1:${port}/__shim/stats`)).json();
	if (stats.errors !== 0) problems.push(`shim が ${stats.errors} 件の失敗を返しました（要求が録音と食い違っています）`);
	if (stats.backend.unused !== 0) problems.push(`録音のうち ${stats.backend.unused} 件が使われませんでした`);
	if (stats.backend.replayed !== stats.backend.recorded) {
		problems.push(`再生した数（${stats.backend.replayed}）が録音の数（${stats.backend.recorded}）と違います`);
	}

	if (problems.length === 0) {
		process.stdout.write(`録音の再生 OK: ${stats.backend.replayed} 往復、LLM 呼び出し 0 回\n`);
	} else {
		process.stderr.write(`録音の再生に失敗しました:\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
		process.stderr.write(`\n--- trans-e2e.js の出力 ---\n${output}\n`);
	}
} finally {
	child.kill("SIGTERM");
}

process.exit(problems.length === 0 ? 0 : 1);
