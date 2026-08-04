// 翻訳のためにコードブロックを退避し、戻すまでの往復（design.md P9）
//
// 大原則: AI が形を一切変えなければ、往復して元の1バイトに戻ること。
// 字下げされたコードブロック（リストの中）や引用の中のコードブロックは、
// バッククォートの位置から切り出すと行頭の前置きが取り残されて壊れる。

import { strict as assert } from "node:assert";
import { isMarkdownExtension, protectCodeBlocks, restoreCodeBlocks } from "../../../../commands/trans/translator";

/** AI が何も変えなかったときの往復 */
function roundTrip(source: string): string {
	const { text, codeBlocks, placeholders } = protectCodeBlocks(source);
	return restoreCodeBlocks(text, placeholders, codeBlocks).text;
}

/** AI がプレースホルダを直前の行につなげて1行にまとめたときの往復 */
function roundTripGlued(source: string): string {
	const { text, codeBlocks, placeholders } = protectCodeBlocks(source);
	const glued = text.replace(/\n(__CODE_BLOCK_PLACEHOLDER_\d+__)/g, " $1");
	return restoreCodeBlocks(glued, placeholders, codeBlocks).text;
}

suite("protectCodeBlocks / restoreCodeBlocks（コードブロックの退避と復元）", () => {
	suite("AI が形を変えなければ往復で元に戻る", () => {
		const cases: Array<[string, string]> = [
			[
				"字下げなしのコードブロック",
				["説明。", "", "```js", "console.log(1);", "```", "", "続き。", ""].join("\n"),
			],
			[
				"リスト項目の中のコードブロック（2スペース字下げ）",
				["手順は次のとおり。", "", "- 手順1: 実行する", "  ```js", "  console.log(1);", "  ```", "- 手順2: 確認する", ""].join("\n"),
			],
			[
				"番号付きリストの中のコードブロック（3スペース字下げ）",
				["1. まず入れる", "   ```sh", "   npm i", "   ```", "2. 次に動かす", ""].join("\n"),
			],
			[
				"引用の中のコードブロック",
				["注意事項。", "", "> 次のように書く。", "> ```js", "> console.log(1);", "> ```", "", "続き。", ""].join("\n"),
			],
			[
				"チルダのコードブロック",
				["説明。", "", "~~~markdown", "<!-- mdait 12345678 -->", "~~~", "", "続き。", ""].join("\n"),
			],
			[
				"字下げ（4スペース）のコードブロック",
				["説明。", "", "    <!-- mdait aabbccdd -->", "    ## サンプル", "", "続き。", ""].join("\n"),
			],
			[
				"4連バッククォートで囲んだコードブロック",
				["説明。", "", "````markdown", "```js", "x", "```", "````", "", "続き。", ""].join("\n"),
			],
			["コードブロックが2つ続く", ["```a", "1", "```", "", "```b", "2", "```", ""].join("\n")],
			["閉じていないコードブロック", ["説明。", "", "```js", "console.log(1);", ""].join("\n")],
			["コードブロックが無い文書", ["# 見出し", "", "本文だけ。", ""].join("\n")],
			["行内のインラインコード", ["説明は ```code``` のとおり。", ""].join("\n")],
		];

		for (const [name, source] of cases) {
			test(`${name}は往復して1バイトも変わらないこと`, () => {
				assert.strictEqual(roundTrip(source), source);
			});
		}
	});

	suite("退避の対象は markdown-it の判定に従う", () => {
		test("チルダのコードブロックも退避されること", () => {
			const { codeBlocks } = protectCodeBlocks(["~~~markdown", "<!-- mdait 12345678 -->", "~~~", ""].join("\n"));
			assert.strictEqual(codeBlocks.length, 1);
		});

		test("字下げのコードブロックも退避されること", () => {
			const { codeBlocks } = protectCodeBlocks(["説明。", "", "    <!-- mdait aabbccdd -->", ""].join("\n"));
			assert.strictEqual(codeBlocks.length, 1);
		});

		test("4連バッククォートは1つのブロックとして退避されること（誤分割しない）", () => {
			const { codeBlocks } = protectCodeBlocks(["````markdown", "```js", "x", "```", "````", ""].join("\n"));
			assert.strictEqual(codeBlocks.length, 1);
		});

		test("退避したブロックには行頭の字下げ・引用記号が含まれること", () => {
			const { codeBlocks } = protectCodeBlocks(["> 注意:", "> ```js", "> console.log(1);", "> ```", ""].join("\n"));
			assert.strictEqual(codeBlocks.length, 1);
			assert.ok(codeBlocks[0].startsWith("> ```js"), codeBlocks[0]);
		});

		test("プレースホルダは必ず単独の行に置かれること", () => {
			const { text } = protectCodeBlocks(["- 手順1: 実行する", "  ```js", "  console.log(1);", "  ```", ""].join("\n"));
			assert.ok(
				text.split("\n").some((l) => l === "__CODE_BLOCK_PLACEHOLDER_0__"),
				text,
			);
		});

		test("AI へ渡すテキストにコードブロックの中身が残らないこと", () => {
			const { text } = protectCodeBlocks(["> ```js", "> console.log(1);", "> ```", ""].join("\n"));
			assert.ok(!text.includes("console.log"), text);
		});

		test("行内のインラインコードも退避されること（従来の保護を落とさない）", () => {
			const { text, codeBlocks } = protectCodeBlocks("説明は ```code``` のとおり。");
			assert.deepStrictEqual(codeBlocks, ["```code```"]);
			assert.ok(!text.includes("code```"), text);
		});

		test("離れた行のバッククォート同士をまとめないこと", () => {
			const { codeBlocks } = protectCodeBlocks(["前の行 ``` だけ。", "", "次の行 ``` だけ。", ""].join("\n"));
			assert.deepStrictEqual(codeBlocks, []);
		});
	});

	suite("Markdown でないファイルには Markdown 固有の規則を当てない", () => {
		test("拡張子の判定（未指定は Markdown 経路とみなす）", () => {
			assert.strictEqual(isMarkdownExtension(undefined), true);
			assert.strictEqual(isMarkdownExtension(".md"), true);
			assert.strictEqual(isMarkdownExtension(".MD"), true);
			assert.strictEqual(isMarkdownExtension(".markdown"), true);
			assert.strictEqual(isMarkdownExtension(".txt"), false);
			assert.strictEqual(isMarkdownExtension(".json"), false);
		});

		test("字下げしただけの本文を退避しないこと（翻訳から外さない）", () => {
			const source = ["プロジェクト概要", "", "    背景", "    目的", "", "以上。"].join("\n");
			const { text, codeBlocks } = protectCodeBlocks(source, { markdown: false });

			assert.deepStrictEqual(codeBlocks, []);
			assert.strictEqual(text, source);
		});

		test("タブで字下げした本文も退避しないこと", () => {
			const source = ["見出し", "", "\t項目1", "\t項目2", "", "以上。"].join("\n");
			const { codeBlocks } = protectCodeBlocks(source, { markdown: false });

			assert.deepStrictEqual(codeBlocks, []);
		});

		test("閉じたフェンスは Markdown でなくても退避すること（従来どおり）", () => {
			const source = ["説明。", "", "```", "code here", "```", "", "以上。"].join("\n");
			const { codeBlocks } = protectCodeBlocks(source, { markdown: false });

			assert.strictEqual(codeBlocks.length, 1);
			assert.strictEqual(codeBlocks[0], ["```", "code here", "```"].join("\n"));
		});

		test("閉じていないフェンスは退避しないこと（末尾まで翻訳から外さない）", () => {
			const source = ["説明。", "", "```", "本文が続く", "さらに本文", ""].join("\n");
			const { text, codeBlocks } = protectCodeBlocks(source, { markdown: false });

			assert.deepStrictEqual(codeBlocks, []);
			assert.strictEqual(text, source);
		});

		test("Markdown では字下げコードブロックを従来どおり退避すること", () => {
			const source = ["説明。", "", "    <!-- mdait aabbccdd -->", "", "以上。"].join("\n");
			const { codeBlocks } = protectCodeBlocks(source, { markdown: true });

			assert.strictEqual(codeBlocks.length, 1);
		});

		test("Markdown でなくても往復して1バイトも変わらないこと", () => {
			const source = ["リリースノート", "", "変更点:", "", "    - 速くなりました", "", "```", "v2.0.0", "```", ""].join("\n");
			const { text, codeBlocks, placeholders } = protectCodeBlocks(source, { markdown: false });

			assert.strictEqual(restoreCodeBlocks(text, placeholders, codeBlocks).text, source);
		});
	});

	suite("AI が行をまとめてもコードブロックが壊れない", () => {
		test("引用の中のブロックは引用のまま行頭へ戻ること", () => {
			const source = ["> 注意:", "> ```js", "> console.log(1);", "> ```", ""].join("\n");
			const lines = roundTripGlued(source).split("\n");

			assert.ok(lines.includes("> ```js"), lines.join("|"));
			// 閉じフェンスが引用記号を失って `> ```」→「```` になっていないこと
			assert.strictEqual(lines.filter((l) => l === "```").length, 0, lines.join("|"));
		});

		test("リストの中のブロックは字下げのまま行頭へ戻ること", () => {
			const source = ["- 手順1:", "  ```js", "  console.log(1);", "  ```", ""].join("\n");
			const lines = roundTripGlued(source).split("\n");

			assert.ok(lines.includes("  ```js"), lines.join("|"));
			assert.strictEqual(lines.filter((l) => l === "```js").length, 0, lines.join("|"));
		});

		test("開始フェンスが行の途中に埋まらないこと", () => {
			const block = ["```markdown", "<!-- mdait 12345678 -->", "## サンプル", "```"].join("\n");
			const restored = restoreCodeBlocks(
				"説明です。 __CODE_BLOCK_PLACEHOLDER_0__ 以上です。",
				["__CODE_BLOCK_PLACEHOLDER_0__"],
				[block],
			).text;

			const lines = restored.split("\n");
			assert.strictEqual(lines[1], "```markdown");
			assert.strictEqual(lines[lines.length - 1], " 以上です。");
		});
	});

	suite("復元そのものの決まりごと", () => {
		test("1行のコードブロックは行の途中でも改行を足さない", () => {
			const restored = restoreCodeBlocks("前 __CODE_BLOCK_PLACEHOLDER_0__ 後", ["__CODE_BLOCK_PLACEHOLDER_0__"], ["``````"]);
			assert.strictEqual(restored.text, "前 `````` 後");
		});

		test("同じプレースホルダが2回現れても両方復元する", () => {
			const block = ["```js", "console.log(1);", "```"].join("\n");
			const restored = restoreCodeBlocks(
				"A __CODE_BLOCK_PLACEHOLDER_0__ B __CODE_BLOCK_PLACEHOLDER_0__ C",
				["__CODE_BLOCK_PLACEHOLDER_0__"],
				[block],
			);
			assert.ok(!restored.text.includes("__CODE_BLOCK_PLACEHOLDER_"));
			assert.strictEqual(restored.text.split("```js").length - 1, 2);
		});

		test("AI がプレースホルダを消したら missing に載ること（黙って消さない）", () => {
			const restored = restoreCodeBlocks(
				"説明です。以上です。",
				["__CODE_BLOCK_PLACEHOLDER_0__", "__CODE_BLOCK_PLACEHOLDER_1__"],
				["```a\n1\n```", "```b\n2\n```"],
			);
			assert.deepStrictEqual(restored.missing, [
				"__CODE_BLOCK_PLACEHOLDER_0__",
				"__CODE_BLOCK_PLACEHOLDER_1__",
			]);
		});

		test("すべて復元できたら missing は空になること", () => {
			const restored = restoreCodeBlocks("__CODE_BLOCK_PLACEHOLDER_0__", ["__CODE_BLOCK_PLACEHOLDER_0__"], ["```a\n1\n```"]);
			assert.deepStrictEqual(restored.missing, []);
		});

		test("復元は冪等（同じ入力を2度通しても同じ結果）", () => {
			const block = ["```js", "console.log(1);", "```"].join("\n");
			const once = restoreCodeBlocks("説明。 __CODE_BLOCK_PLACEHOLDER_0__ 続き。", ["__CODE_BLOCK_PLACEHOLDER_0__"], [block]).text;
			const twice = restoreCodeBlocks(once, ["__CODE_BLOCK_PLACEHOLDER_0__"], [block]).text;
			assert.strictEqual(twice, once);
		});
	});
});
