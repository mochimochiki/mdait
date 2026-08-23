#!/usr/bin/env node
/*
 * 録音した実機の往復を、そのまま無人で再現する回帰テスト。
 *
 * recordings/trans-en-child.jsonl は、翻訳役に claude を据えて実際に走らせたときの
 * 12往復をそのまま録ったもの。ここではその録音を相手に mdait の trans を走らせ、
 * 同じ結果になることを確かめる。LLM は1回も呼ばないので、費用も鍵も要らない。
 *
 * 要求が録音と1文字でも違えば shim が 409 を返し、このテストは落ちる。
 * つまりプロンプトの組み立てが変わったことに、ここで気づける。
 *
 * 「実際に trans を走らせる役（駆動役）」はここには無い。lab のホストが受け持つので、
 * 外から渡してもらう。`--` の後ろに書いたものが駆動役のコマンドになる。
 *
 *   node scripts/lab/ai/replay-e2e.mjs -- node scripts/lab/lab.mjs trans-dir en/child --shim {baseURL}
 *
 * 引数の中の `{baseURL}` は、立てた shim の繋ぎ先（http://127.0.0.1:PORT/v1）に置き換わる。
 * 同じ値は環境変数 MDAIT_AI_BASE_URL でも渡すので、置き換えの目印を書かなくてもよい。
 *
 * 駆動役に求めることは2つだけ。
 *   - 成功したら終了コード 0 で終わる
 *   - ファイルごとに1行、対象のパス・`"translatedCount":N`・`残った need: {"-"...}` を含む行を出す
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startShim } from "./embed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDING = path.join(HERE, "recordings", "trans-en-child.jsonl");

/** 録音を録ったときの結果。再生しても同じにならなければ、どこかが変わっている */
export const EXPECTED = [
	{ file: "en/child/child2/child2_1.md", units: 5 },
	{ file: "en/child/child2/child2_2.md", units: 2 },
	{ file: "en/child/child_ja_new.md", units: 2 },
];

/** 駆動役を1回走らせる。標準出力と標準エラーはまとめて拾う */
export function spawnDriver(command, args, { baseURL }) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, MDAIT_AI_BASE_URL: baseURL },
		});
		let output = "";
		child.stdout.on("data", (buffer) => {
			output += buffer.toString();
		});
		child.stderr.on("data", (buffer) => {
			output += buffer.toString();
		});
		child.on("error", (error) => resolve({ code: 127, output: `${output}\n駆動役を起動できません: ${error.message}` }));
		child.on("close", (code) => resolve({ code, output }));
	});
}

/**
 * 録音を相手に駆動役を走らせ、食い違いを並べて返す。
 *
 * @param {object} options
 * @param {(context: {baseURL: string, port: number}) => Promise<{code: number, output: string}>} options.runDriver
 * @param {string} [options.recording] 再生する録音
 * @param {Array<{file: string, units: number}>} [options.expected] 期待する結果
 * @returns {Promise<{problems: string[], output: string, stats: object}>}
 */
export async function replayRegression({ runDriver, recording = RECORDING, expected = EXPECTED }) {
	const problems = [];
	const ai = await startShim({ mode: "replay", replay: recording, port: 0 });
	try {
		const { code, output } = await runDriver({ baseURL: ai.baseURL, port: ai.port });
		if (code !== 0) problems.push(`駆動役が終了コード ${code} で落ちました`);

		for (const item of expected) {
			const line = output.split("\n").find((row) => row.includes(item.file));
			if (!line) {
				problems.push(`${item.file} の結果が出力にありません`);
				continue;
			}
			if (!line.includes(`"translatedCount":${item.units}`)) {
				problems.push(`${item.file}: 訳した数が ${item.units} ではありません → ${line.trim()}`);
			}
			if (!line.includes('残った need: {"-"')) {
				problems.push(`${item.file}: need が残っています → ${line.trim()}`);
			}
		}

		const stats = ai.stats();
		if (stats.errors !== 0)
			problems.push(`shim が ${stats.errors} 件の失敗を返しました（要求が録音と食い違っています）`);
		if (stats.backend.unused !== 0) problems.push(`録音のうち ${stats.backend.unused} 件が使われませんでした`);
		if (stats.backend.replayed !== stats.backend.recorded) {
			problems.push(`再生した数（${stats.backend.replayed}）が録音の数（${stats.backend.recorded}）と違います`);
		}
		return { problems, output, stats };
	} finally {
		await ai.close();
	}
}

const USAGE = `録音を再生して trans が同じ結果になるかを見る

  node scripts/lab/ai/replay-e2e.mjs [--recording <ファイル>] -- <駆動役のコマンド> [引数...]

引数の中の {baseURL} は shim の繋ぎ先に置き換わる。環境変数 MDAIT_AI_BASE_URL でも渡す。
`;

function parseArgs(argv) {
	const options = { recording: RECORDING, driver: [] };
	for (let at = 0; at < argv.length; at += 1) {
		const flag = argv[at];
		if (flag === "--") {
			options.driver = argv.slice(at + 1);
			break;
		}
		if (flag === "--recording") options.recording = path.resolve(argv[++at]);
		else if (flag === "-h" || flag === "--help") {
			process.stdout.write(USAGE);
			process.exit(0);
		} else {
			process.stderr.write(`知らないオプションです: ${flag}\n\n${USAGE}`);
			process.exit(2);
		}
	}
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.driver.length === 0) {
		process.stderr.write(`駆動役が指定されていません（\`--\` の後ろに書きます）\n\n${USAGE}`);
		process.exit(2);
	}

	const { problems, output, stats } = await replayRegression({
		recording: options.recording,
		runDriver: ({ baseURL }) => {
			const [command, ...rest] = options.driver;
			const args = rest.map((value) => value.replaceAll("{baseURL}", baseURL));
			return spawnDriver(command, args, { baseURL });
		},
	});

	if (problems.length === 0) {
		process.stdout.write(`録音の再生 OK: ${stats.backend.replayed} 往復、LLM 呼び出し 0 回\n`);
		process.exit(0);
	}
	process.stderr.write(`録音の再生に失敗しました:\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
	process.stderr.write(`\n--- 駆動役の出力 ---\n${output}\n`);
	process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	await main();
}
