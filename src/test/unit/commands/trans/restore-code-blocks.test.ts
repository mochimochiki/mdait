// 翻訳結果へコードブロックを戻すときの行の扱い（design.md P9）
// AI がプレースホルダを前後の文とつなげて1行にまとめても、
// 戻したコードブロックが行の途中に埋まって壊れないこと。

import { strict as assert } from "node:assert";
import { restoreCodeBlocks } from "../../../../commands/trans/translator";

suite("restoreCodeBlocks（コードブロックの復元）", () => {
	test("行の途中に戻る複数行コードブロックは行頭・行末へ送られる", () => {
		const block = ["```markdown", "<!-- mdait 12345678 -->", "## サンプル", "```"].join("\n");
		const text = "見出しの説明です。 __CODE_BLOCK_PLACEHOLDER_0__ 以上です。";

		const restored = restoreCodeBlocks(text, ["__CODE_BLOCK_PLACEHOLDER_0__"], [block]);

		const lines = restored.split("\n");
		assert.strictEqual(lines[0], "見出しの説明です。 ");
		assert.strictEqual(lines[1], "```markdown");
		assert.strictEqual(lines[lines.length - 2], "```");
		assert.strictEqual(lines[lines.length - 1], " 以上です。");
	});

	test("すでに行頭・行末にあるプレースホルダには改行を足さない", () => {
		const block = ["```js", "console.log(1);", "```"].join("\n");
		const text = "説明。\n\n__CODE_BLOCK_PLACEHOLDER_0__\n\n続き。";

		const restored = restoreCodeBlocks(text, ["__CODE_BLOCK_PLACEHOLDER_0__"], [block]);

		assert.strictEqual(restored, `説明。\n\n${block}\n\n続き。`);
	});

	test("1行のコードブロックは行の途中でも改行を足さない", () => {
		const text = "前 __CODE_BLOCK_PLACEHOLDER_0__ 後";

		const restored = restoreCodeBlocks(text, ["__CODE_BLOCK_PLACEHOLDER_0__"], ["``````"]);

		assert.strictEqual(restored, "前 `````` 後");
	});

	test("複数のプレースホルダをそれぞれ復元する", () => {
		const a = ["```a", "1", "```"].join("\n");
		const b = ["```b", "2", "```"].join("\n");
		const text = "X __CODE_BLOCK_PLACEHOLDER_0__ Y __CODE_BLOCK_PLACEHOLDER_1__ Z";

		const restored = restoreCodeBlocks(
			text,
			["__CODE_BLOCK_PLACEHOLDER_0__", "__CODE_BLOCK_PLACEHOLDER_1__"],
			[a, b],
		);

		assert.ok(restored.includes(`\n${a}\n`));
		assert.ok(restored.includes(`\n${b}\n`));
		assert.ok(!restored.includes("__CODE_BLOCK_PLACEHOLDER_"));
	});

	test("同じプレースホルダが2回現れても両方復元する", () => {
		const block = ["```js", "console.log(1);", "```"].join("\n");
		const text = "A __CODE_BLOCK_PLACEHOLDER_0__ B __CODE_BLOCK_PLACEHOLDER_0__ C";

		const restored = restoreCodeBlocks(text, ["__CODE_BLOCK_PLACEHOLDER_0__"], [block]);

		assert.ok(!restored.includes("__CODE_BLOCK_PLACEHOLDER_"));
		assert.strictEqual(restored.split("```js").length - 1, 2);
	});
});
