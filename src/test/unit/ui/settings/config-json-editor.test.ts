import * as assert from "node:assert";
import {
	detectIndent,
	removeConfigValue,
	setConfigValue,
} from "../../../../ui/settings/config-json-editor";

const SAMPLE = `{
  "transPairs": [
    {
      "sourceLang": "ja",
      "sourceDir": "docs/ja",
      "targetLang": "en",
      "targetDir": "docs/en"
    }
  ],
  "primaryLang": "en",
  "sync": {
    "level": 3
  }
}
`;

suite("config-json-editor: mdait.json テキストのキー単位更新", () => {
	test("既存キーの値を更新できる", () => {
		const result = setConfigValue(SAMPLE, ["sync", "level"], 2);
		const parsed = JSON.parse(result);
		assert.strictEqual(parsed.sync.level, 2);
	});

	test("存在しない中間オブジェクトを自動生成して値を設定する", () => {
		const result = setConfigValue(SAMPLE, ["ai", "ollama", "endpoint"], "http://localhost:11434");
		const parsed = JSON.parse(result);
		assert.strictEqual(parsed.ai.ollama.endpoint, "http://localhost:11434");
	});

	test("既存キーの順序が保持される", () => {
		const result = setConfigValue(SAMPLE, ["sync", "level"], 5);
		const keys = Object.keys(JSON.parse(result));
		assert.deepStrictEqual(keys, ["transPairs", "primaryLang", "sync"]);
	});

	test("2スペースインデントと末尾改行が保持される", () => {
		const result = setConfigValue(SAMPLE, ["primaryLang"], "ja");
		assert.ok(result.includes('\n  "primaryLang": "ja"'), "2スペースインデント");
		assert.ok(result.endsWith("\n"), "末尾改行");
	});

	test("タブインデントのファイルではタブが保持される", () => {
		const tabText = '{\n\t"primaryLang": "en"\n}\n';
		const result = setConfigValue(tabText, ["primaryLang"], "ja");
		assert.ok(result.includes('\n\t"primaryLang": "ja"'));
	});

	test("末尾改行が無いファイルでは改行を追加しない", () => {
		const noNewline = '{\n  "primaryLang": "en"\n}';
		const result = setConfigValue(noNewline, ["primaryLang"], "ja");
		assert.ok(!result.endsWith("\n"));
	});

	test("キー削除で値が取り除かれる", () => {
		const result = removeConfigValue(SAMPLE, ["sync", "level"]);
		const parsed = JSON.parse(result);
		assert.strictEqual(parsed.sync, undefined, "空になった親 sync も刈り取られる");
	});

	test("空になった親オブジェクトはルートまで再帰的に刈り取られる", () => {
		const text = '{\n  "ai": {\n    "ollama": {\n      "endpoint": "x"\n    }\n  },\n  "primaryLang": "en"\n}\n';
		const result = removeConfigValue(text, ["ai", "ollama", "endpoint"]);
		const parsed = JSON.parse(result);
		assert.strictEqual(parsed.ai, undefined);
		assert.strictEqual(parsed.primaryLang, "en");
	});

	test("親に他のキーが残る場合は親を刈り取らない", () => {
		const text = '{\n  "sync": {\n    "level": 3,\n    "autoDelete": true\n  }\n}\n';
		const result = removeConfigValue(text, ["sync", "level"]);
		const parsed = JSON.parse(result);
		assert.strictEqual(parsed.sync.level, undefined);
		assert.strictEqual(parsed.sync.autoDelete, true);
	});

	test("存在しないパスの削除は元のテキストをそのまま返す", () => {
		const result = removeConfigValue(SAMPLE, ["tm", "enabled"]);
		assert.strictEqual(result, SAMPLE);
	});

	test("配列値（transPairs）を丸ごと設定できる", () => {
		const pairs = [
			{ sourceLang: "en", sourceDir: "docs/en", targetLang: "de", targetDir: "docs/de" },
		];
		const result = setConfigValue(SAMPLE, ["transPairs"], pairs);
		const parsed = JSON.parse(result);
		assert.deepStrictEqual(parsed.transPairs, pairs);
	});

	test("不正な JSON テキストはエラーになる", () => {
		assert.throws(() => setConfigValue("{ broken", ["primaryLang"], "ja"));
	});

	test("detectIndent: インデントが検出できない場合は2スペースを返す", () => {
		assert.strictEqual(detectIndent("{}"), "  ");
	});
});
