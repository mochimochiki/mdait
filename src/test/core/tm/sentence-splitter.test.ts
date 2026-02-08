import * as assert from "node:assert";
import { SentenceSplitter } from "../../../core/tm/sentence-splitter";

suite("SentenceSplitter", () => {
	let splitter: SentenceSplitter;

	setup(() => {
		splitter = new SentenceSplitter();
	});

	suite("日本語分割", () => {
		test("句点で文が分割される", () => {
			const result = splitter.split("最初の文です。次の文です。最後の文です。", "ja");
			assert.deepStrictEqual(result, ["最初の文です。", "次の文です。", "最後の文です。"]);
		});

		test("感嘆符・疑問符でも分割される", () => {
			const result = splitter.split("これは驚きです！本当ですか？はい。", "ja");
			assert.deepStrictEqual(result, ["これは驚きです！", "本当ですか？", "はい。"]);
		});

		test("数値内のドットでは分割されない", () => {
			const result = splitter.split("バージョン3.14をダウンロードします。次の手順に進みます。", "ja");
			assert.strictEqual(result.length, 2);
			assert.ok(result[0].includes("3.14"));
		});

		test("句読点がない場合は1文として返される", () => {
			const result = splitter.split("句読点のないテキスト", "ja");
			assert.deepStrictEqual(result, ["句読点のないテキスト"]);
		});
	});

	suite("英語分割", () => {
		test("ピリオド+空白+大文字で文が分割される", () => {
			const result = splitter.split("First sentence. Second sentence. Third sentence.", "en");
			assert.deepStrictEqual(result, ["First sentence.", "Second sentence.", "Third sentence."]);
		});

		test("感嘆符・疑問符+空白+大文字でも分割される", () => {
			const result = splitter.split("What is this? It is a test! Amazing.", "en");
			assert.deepStrictEqual(result, ["What is this?", "It is a test!", "Amazing."]);
		});

		test("小文字が続く場合は分割されない", () => {
			const result = splitter.split("e.g. this is not split here.", "en");
			assert.strictEqual(result.length, 1);
		});

		test("数値内のドットでは分割されない", () => {
			const result = splitter.split("Version 3.14 is available. Download it now.", "en");
			assert.strictEqual(result.length, 2);
			assert.ok(result[0].includes("3.14"));
		});
	});

	suite("Markdown保護", () => {
		test("コードブロック内は分割されない", () => {
			const text = "説明文です。\n\n```\ncode.here. More code.\n```\n\n続きの文です。";
			const result = splitter.split(text, "ja");
			// コードブロックは1つの文として保持される
			const hasCodeBlock = result.some((s) => s.includes("code.here"));
			assert.ok(hasCodeBlock, "コードブロックが保持されている");
		});

		test("インラインコード内は分割されない", () => {
			const text = "`config.value` を設定します。次の手順です。";
			const result = splitter.split(text, "ja");
			assert.strictEqual(result.length, 2);
			assert.ok(result[0].includes("`config.value`"));
		});
	});

	suite("リスト項目", () => {
		test("リスト項目が独立した文として分割される", () => {
			const text = "- 最初の項目\n- 2番目の項目\n- 3番目の項目";
			const result = splitter.split(text, "ja");
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0], "最初の項目");
			assert.strictEqual(result[1], "2番目の項目");
			assert.strictEqual(result[2], "3番目の項目");
		});

		test("番号付きリストが独立した文として分割される", () => {
			const text = "1. First item\n2. Second item\n3. Third item";
			const result = splitter.split(text, "en");
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0], "First item");
		});
	});

	suite("エッジケース", () => {
		test("空文字列は空配列を返す", () => {
			const result = splitter.split("", "ja");
			assert.deepStrictEqual(result, []);
		});

		test("空白のみは空配列を返す", () => {
			const result = splitter.split("   \n\n   ", "en");
			assert.deepStrictEqual(result, []);
		});

		test("段落が空行で区切られている場合、各段落が個別に処理される", () => {
			const text = "最初の段落です。\n\n2番目の段落です。";
			const result = splitter.split(text, "ja");
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0], "最初の段落です。");
			assert.strictEqual(result[1], "2番目の段落です。");
		});

		test("日英混合テキストがja言語設定で日本語ルールで分割される", () => {
			const text = "English text here。日本語テキストです。";
			const result = splitter.split(text, "ja");
			assert.strictEqual(result.length, 2);
		});
	});
});
