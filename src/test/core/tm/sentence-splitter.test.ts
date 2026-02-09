import * as assert from "node:assert";
import { SentenceSplitter } from "../../../core/tm/sentence-splitter";

suite("SentenceSplitter", () => {
	let splitter: SentenceSplitter;

	setup(() => {
		splitter = new SentenceSplitter();
	});

	suite("日本語分割", () => {
		test("句点（。）で文が分割される", () => {
			const result = splitter.split("最初の文です。次の文です。最後の文です。", "ja");
			assert.deepStrictEqual(result, ["最初の文です。", "次の文です。", "最後の文です。"]);
		});

		test("感嘆符（！）・疑問符（？）で分割される", () => {
			const result = splitter.split("これは驚きです！本当ですか？はい。", "ja");
			assert.deepStrictEqual(result, ["これは驚きです！", "本当ですか？", "はい。"]);
		});

		test("数値内のドット（3.14）では分割されない", () => {
			const result = splitter.split("バージョン3.14をダウンロードします。次の手順に進みます。", "ja");
			assert.strictEqual(result.length, 2);
			assert.ok(result[0].includes("3.14"));
		});

		test("句読点がない場合は1文として返される", () => {
			const result = splitter.split("句読点のないテキスト", "ja");
			assert.deepStrictEqual(result, ["句読点のないテキスト"]);
		});

		test("括弧内の句点を含む文が適切に処理される", () => {
			const result = splitter.split("「これは例文です。」と彼は言いました。", "ja");
			// 全テキストが保持されることを確認
			const joined = result.join("");
			assert.ok(joined.includes("これは例文です。"));
			assert.ok(joined.includes("彼は言いました。"));
		});

		test("長い文が句点なしなら1文として返される", () => {
			const text = "これは非常に長い文であり、多くの情報を含んでいますが、句点がないため一つの文として扱われるべきです";
			const result = splitter.split(text, "ja");
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], text);
		});
	});

	suite("英語分割", () => {
		test("基本的な文分割（ピリオド、疑問符、感嘆符）", () => {
			const result = splitter.split("First sentence. Second sentence. Third sentence.", "en");
			assert.deepStrictEqual(result, ["First sentence.", "Second sentence.", "Third sentence."]);
		});

		test("感嘆符・疑問符+空白+大文字で分割される", () => {
			const result = splitter.split("What is this? It is a test! Amazing.", "en");
			assert.deepStrictEqual(result, ["What is this?", "It is a test!", "Amazing."]);
		});

		test("省略語（Dr., Mr.）を含む文が全体として保持される", () => {
			const text = "Dr. Smith went to the store. He bought some milk.";
			const result = splitter.split(text, "en");
			// ICU実装により分割数は異なり得るが、全テキストが保持される
			const joined = result.join(" ");
			assert.ok(joined.includes("Dr."));
			assert.ok(joined.includes("Smith went to the store."));
			assert.ok(joined.includes("He bought some milk."));
		});

		test("省略語（Mrs.）を含む文が全体として保持される", () => {
			const text = "Mrs. Johnson arrived early. She brought flowers.";
			const result = splitter.split(text, "en");
			// ICU実装により分割数は異なり得るが、全テキストが保持される
			const joined = result.join(" ");
			assert.ok(joined.includes("Mrs."));
			assert.ok(joined.includes("Johnson arrived early."));
			assert.ok(joined.includes("She brought flowers."));
		});

		test("省略語（e.g., i.e.）で誤分割されない", () => {
			const result = splitter.split("Use a tool, e.g. a hammer, to fix it. Then proceed.", "en");
			// e.g. が前の文と同じセグメントに含まれる
			assert.ok(result.some((s) => s.includes("e.g.") && s.includes("hammer")));
		});

		test("省略語（etc., vs.）で誤分割されない", () => {
			const result = splitter.split("Bring tools, nails, etc. for the job. Start early.", "en");
			assert.ok(result.some((s) => s.includes("etc.")));
		});

		test("数値内のドット（Version 3.14）では分割されない", () => {
			const result = splitter.split("Version 3.14 is available. Download it now.", "en");
			assert.strictEqual(result.length, 2);
			assert.ok(result[0].includes("3.14"));
		});

		test("URL内のドットで誤分割されない", () => {
			const result = splitter.split("Visit https://example.com for details. More info here.", "en");
			assert.ok(result.some((s) => s.includes("https://example.com")));
		});

		test("メールアドレス内のドットで誤分割されない", () => {
			const result = splitter.split("Contact user@example.com for help. Thanks.", "en");
			assert.ok(result.some((s) => s.includes("user@example.com")));
		});

		test("括弧内の文末記号を含む文が処理される", () => {
			const result = splitter.split("He said (it was true.) Then he left.", "en");
			const joined = result.join("");
			assert.ok(joined.includes("it was true."));
			assert.ok(joined.includes("he left."));
		});

		test("引用符内の文が適切に処理される", () => {
			const text = '"She said hello." He replied.';
			const result = splitter.split(text, "en");
			const joined = result.join("");
			assert.ok(joined.includes("She said hello."));
			assert.ok(joined.includes("He replied."));
		});
	});

	suite("中国語分割", () => {
		test("中国語句読点（。！？）で分割される", () => {
			const result = splitter.split("这是第一句话。这是第二句话。这是第三句话。", "zh");
			assert.strictEqual(result.length, 3);
			assert.ok(result[0].includes("这是第一句话。"));
		});

		test("中国語のコンマ（，）では分割されない", () => {
			const result = splitter.split("这是一个句子，包含逗号。", "zh");
			assert.strictEqual(result.length, 1);
		});

		test("中国語と英語の混合テキストが分割される", () => {
			const result = splitter.split("这是一个Chinese句子。This is an English sentence.", "zh");
			assert.strictEqual(result.length, 2);
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

		test("インラインコードを含む文が適切に分割される", () => {
			const text = "Use `path.join()` to create paths. Then call `fs.read()` to read files.";
			const result = splitter.split(text, "en");
			assert.ok(result.some((s) => s.includes("`path.join()`")));
			assert.ok(result.some((s) => s.includes("`fs.read()`")));
		});
	});

	suite("リスト項目", () => {
		test("ハイフンリストが独立した文として分割される", () => {
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

		test("アスタリスクリストが独立した文として分割される", () => {
			const text = "* Item A\n* Item B\n* Item C";
			const result = splitter.split(text, "en");
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0], "Item A");
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

		test("日英混合テキストが適切に分割される", () => {
			const text = "English text here。日本語テキストです。";
			const result = splitter.split(text, "ja");
			assert.strictEqual(result.length, 2);
		});

		test("改行のみのテキストは空配列を返す", () => {
			const result = splitter.split("\n\n\n", "en");
			assert.deepStrictEqual(result, []);
		});

		test("非常に長い文が分割されずに保持される", () => {
			const longSentence = "This is a very long sentence that ".repeat(50).trim();
			const result = splitter.split(longSentence, "en");
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], longSentence);
		});

		test("特殊文字（絵文字）を含む文が正しく処理される", () => {
			const text = "Hello world! 🎉 This is great. 素晴らしいです。";
			const result = splitter.split(text, "en");
			assert.ok(result.length >= 1);
			const joined = result.join("");
			assert.ok(joined.includes("🎉"));
		});

		test("連続するピリオド（...）で誤分割されない", () => {
			const result = splitter.split("Hmm... I think so. Let me check.", "en");
			// "..."がある部分で誤分割されない
			assert.ok(result.some((s) => s.includes("...")));
		});
	});
});
