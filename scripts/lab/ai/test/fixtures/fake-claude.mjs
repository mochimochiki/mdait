#!/usr/bin/env node
/*
 * テスト用の偽 claude コマンド。
 * 本物を呼ぶとネットワークと認証が要るので、AgentBackend の配線だけをここで確かめる。
 *
 * 標準入力のプロンプトに含まれる合図で振る舞いを変える:
 *   FAIL  → 終了コード 1 で落ちる
 *   SLOW  → 400ms 待ってから返す（同時実行数の確認に使う）
 *   それ以外 → プロンプトと --system-prompt の中身をそのまま返す
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const systemAt = args.indexOf("--system-prompt");
const system = systemAt >= 0 ? args[systemAt + 1] : "";
const prompt = fs.readFileSync(0, "utf8");

if (prompt.includes("FAIL")) {
	process.stderr.write("偽 claude はわざと落ちました\n");
	process.exit(1);
}

const emit = () => {
	process.stdout.write(
		JSON.stringify({
			is_error: false,
			result: `system=${system}|prompt=${prompt}`,
			usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3 },
		}),
	);
};

if (prompt.includes("SLOW")) setTimeout(emit, 400);
else emit();
