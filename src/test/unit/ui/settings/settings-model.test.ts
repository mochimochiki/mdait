import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type JsonSchemaNode,
	type SettingsCategory,
	buildSettingsModel,
} from "../../../../ui/settings/settings-model";

/** 実スキーマ（assets/schemas/mdait-config.schema.json）を読み込む */
function loadRealSchema(): JsonSchemaNode {
	const schemaPath = path.join(
		__dirname,
		"../../../../..",
		"assets/schemas/mdait-config.schema.json",
	);
	return JSON.parse(fs.readFileSync(schemaPath, "utf8")) as JsonSchemaNode;
}

function findSetting(categories: SettingsCategory[], id: string) {
	for (const category of categories) {
		const found = category.settings.find((setting) => setting.id === id);
		if (found) {
			return found;
		}
	}
	return undefined;
}

suite("settings-model: スキーマから設定モデルを生成する", () => {
	const categories = buildSettingsModel(loadRealSchema());

	test("トップレベルのスカラー設定は general カテゴリに集約される", () => {
		const general = categories.find((category) => category.id === "general");
		assert.ok(general, "general カテゴリが存在する");
		const ids = general.settings.map((setting) => setting.id);
		assert.ok(ids.includes("transPairs"));
		assert.ok(ids.includes("primaryLang"));
		assert.ok(ids.includes("ignoredPatterns"));
	});

	test("general カテゴリが先頭に配置される", () => {
		assert.strictEqual(categories[0].id, "general");
	});

	test("$schema プロパティはモデルから除外される", () => {
		assert.strictEqual(findSetting(categories, "$schema"), undefined);
	});

	test("ネストした設定はドット結合 ID とキーパス配列を持つ", () => {
		const endpoint = findSetting(categories, "ai.ollama.endpoint");
		assert.ok(endpoint, "ai.ollama.endpoint が抽出される");
		assert.deepStrictEqual(endpoint.path, ["ai", "ollama", "endpoint"]);
		assert.strictEqual(endpoint.category, "ai");
		assert.strictEqual(endpoint.type, "string");
	});

	test("enum・default・minimum・maximum がディスクリプタへ伝播する", () => {
		const level = findSetting(categories, "sync.level");
		assert.ok(level);
		assert.strictEqual(level.type, "integer");
		assert.strictEqual(level.default, 3);
		// sync.level は 0（完全手動マーカー配置）を保存値としては許すが、設定エディタでは
		// 選ばせない。x-ui-minimum がスキーマの minimum より優先される（ADR-260802-02）
		assert.strictEqual(level.minimum, 1);
		assert.strictEqual(level.maximum, 6);

		const policy = findSetting(categories, "sync.orphanTargetPolicy");
		assert.ok(policy);
		assert.strictEqual(policy.type, "enum");
		assert.deepStrictEqual(policy.enum, ["delete", "verify"]);
	});

	test("transPairs は objectArray として抽出され文字列フィールドを列に持つ", () => {
		const transPairs = findSetting(categories, "transPairs");
		assert.ok(transPairs);
		assert.strictEqual(transPairs.type, "objectArray");
		assert.strictEqual(transPairs.required, true);
		const fieldKeys = (transPairs.itemFields ?? []).map((field) => field.key);
		assert.deepStrictEqual(fieldKeys, [
			"sourceLang",
			"sourceDir",
			"targetLang",
			"targetDir",
		]);
		for (const field of transPairs.itemFields ?? []) {
			assert.strictEqual(field.required, true, `${field.key} は必須`);
		}
	});

	test("ignoredPatterns（string | string[] の oneOf）は stringArray になる", () => {
		const ignored = findSetting(categories, "ignoredPatterns");
		assert.ok(ignored);
		assert.strictEqual(ignored.type, "stringArray");
		assert.ok(ignored.description.length > 0, "oneOf 内の description を補完する");
	});

	test("prompts のドット入りキーは path 配列で実キーとして保持される", () => {
		const prompt = findSetting(categories, "prompts.trans.translate");
		assert.ok(prompt);
		assert.deepStrictEqual(prompt.path, ["prompts", "trans.translate"]);
		assert.strictEqual(prompt.category, "prompts");
	});

	test("型が [string, number] の設定（keepAlive）は string ウィジェットになる", () => {
		const keepAlive = findSetting(categories, "ai.ollama.keepAlive");
		assert.ok(keepAlive);
		assert.strictEqual(keepAlive.type, "string");
	});

	test("boolean と array の複合 oneOf（copyAssets）は unsupported フォールバックになる", () => {
		const copyAssets = findSetting(categories, "sync.copyAssets");
		assert.ok(copyAssets, "sync.copyAssets がスキーマに定義されている");
		assert.strictEqual(copyAssets.type, "unsupported");
	});

	test("すべてのカテゴリが 1 件以上の設定を持つ", () => {
		for (const category of categories) {
			assert.ok(
				category.settings.length > 0,
				`カテゴリ ${category.id} が空でない`,
			);
		}
	});

	test("すべての設定が説明文を持つ（スキーマ description の網羅性）", () => {
		for (const category of categories) {
			for (const setting of category.settings) {
				assert.ok(
					setting.description.length > 0,
					`${setting.id} に description がある`,
				);
			}
		}
	});
});
