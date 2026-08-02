/**
 * @file source-diff.test.ts
 * @description 原文の新旧差分（純関数）の単体テスト。need:revise の Hover に出す材料。
 */
import * as assert from "node:assert";
import { diffSourceLines, formatSourceDiff } from "../../../../core/markdown/source-diff";

suite("diffSourceLines（原文の新旧差分）", () => {
	test("変更が無ければ差分は空", () => {
		const text = "## 見出し\n\n本文です。\n";
		const result = diffSourceLines(text, text);
		assert.deepStrictEqual(result.lines, []);
		assert.strictEqual(result.added, 0);
		assert.strictEqual(result.removed, 0);
	});

	test("改行コードと末尾の空行の差は変更として扱わない", () => {
		const result = diffSourceLines("## 見出し\n\n本文です。\n", "## 見出し\r\n\r\n本文です。\r\n\r\n");
		assert.deepStrictEqual(result.lines, []);
	});

	test("書き換えた行が - と + の両方で出る", () => {
		const result = diffSourceLines("## 見出し\n\n古い本文。\n", "## 見出し\n\n新しい本文。\n");
		assert.strictEqual(result.removed, 1);
		assert.strictEqual(result.added, 1);
		assert.ok(
			result.lines.some((l) => l.kind === "removed" && l.text === "古い本文。"),
			"旧行が removed で出る",
		);
		assert.ok(
			result.lines.some((l) => l.kind === "added" && l.text === "新しい本文。"),
			"新行が added で出る",
		);
	});

	test("追加された行だけを検出できる", () => {
		const result = diffSourceLines("## 見出し\n\n一行目。\n", "## 見出し\n\n一行目。\n二行目。\n");
		assert.strictEqual(result.added, 1);
		assert.strictEqual(result.removed, 0);
	});

	test("変更行の周りだけを返す（離れた無関係な行は落とす）", () => {
		const oldText = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
		const newText = ["a", "b", "c", "d", "e", "f", "G"].join("\n");
		const result = diffSourceLines(oldText, newText, { contextLines: 1 });
		assert.ok(
			result.lines.every((l) => l.text !== "a"),
			"離れた先頭行は含まれない",
		);
		assert.ok(
			result.lines.some((l) => l.kind === "context" && l.text === "f"),
			"変更行の直前は文脈として含まれる",
		);
	});

	test("maxLines を超えたら切り捨てて truncated を立てる", () => {
		const oldText = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
		const newText = Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n");
		const result = diffSourceLines(oldText, newText, { maxLines: 10 });
		assert.strictEqual(result.lines.length, 10);
		assert.strictEqual(result.truncated, true);
	});

	test("入力が大きすぎるときは比較しない（tooLarge）", () => {
		const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const result = diffSourceLines(big, `${big}\nextra`, { maxInputLines: 10 });
		assert.strictEqual(result.tooLarge, true);
		assert.deepStrictEqual(result.lines, []);
	});
});

suite("formatSourceDiff（差分の整形）", () => {
	test("diff コードフェンスに +/- 付きで整形する", () => {
		const result = diffSourceLines("## 見出し\n\n古い本文。\n", "## 見出し\n\n新しい本文。\n");
		const formatted = formatSourceDiff(result);
		assert.ok(formatted.startsWith("```diff\n"), "diff フェンスで始まる");
		assert.ok(formatted.endsWith("\n```"), "フェンスで閉じる");
		assert.ok(formatted.includes("-古い本文。"), "削除行に - が付く");
		assert.ok(formatted.includes("+新しい本文。"), "追加行に + が付く");
	});

	test("差分が無ければ空文字（Hover を出さない判断に使う）", () => {
		const same = diffSourceLines("同じ\n", "同じ\n");
		assert.strictEqual(formatSourceDiff(same), "");
	});

	test("原文にコードフェンスが含まれてもブロックが途中で閉じない", () => {
		// ドキュメントの原文にコードブロックがあるのは普通。固定長のフェンスだとそこで閉じてしまい、
		// 続きが Hover の（isTrusted な）Markdown として解釈されてしまう
		const oldText = "## 例\n\n```bash\nnpm install foo\n```\n";
		const newText = "## 例\n\n```bash\nnpm install bar\n```\n";
		const formatted = formatSourceDiff(diffSourceLines(oldText, newText));

		const fence = formatted.slice(0, formatted.indexOf("diff"));
		assert.ok(fence.length > 3, `本文のバッククォートより長いフェンスになる (実際: ${fence.length})`);
		assert.ok(formatted.endsWith(`\n${fence}`), "同じ長さのフェンスで閉じる");
		// 開始と終了以外に、そのフェンスと同じ長さの行が現れない
		const body = formatted.split("\n").slice(1, -1);
		assert.ok(
			body.every((line) => !line.startsWith(fence)),
			"本文中にフェンスを閉じる行が無い",
		);
	});

	test("さらに長いバッククォート列にも追随する", () => {
		const oldText = "````\ncode\n````\n";
		const newText = "````\nchanged\n````\n";
		const formatted = formatSourceDiff(diffSourceLines(oldText, newText));
		const fence = formatted.slice(0, formatted.indexOf("diff"));
		assert.strictEqual(fence, "`".repeat(5), "本文の最長連続（4）より1つ長い");
	});
});
