import * as assert from "node:assert";
import {
	TOOL_SCHEMA_VERSION,
	ToolErrorCode,
	createErrorEnvelope,
	createOkEnvelope,
	serializeEnvelope,
} from "../../../lm-tools/envelope";

suite("ToolEnvelope（LM Tools共通エンベロープ）", () => {
	suite("createOkEnvelope", () => {
		test("成功エンベロープに schemaVersion / ok / summary が含まれる", () => {
			const env = createOkEnvelope("done", { count: 1 }, ["next"]);
			assert.strictEqual(env.schemaVersion, TOOL_SCHEMA_VERSION);
			assert.strictEqual(env.ok, true);
			assert.strictEqual(env.summary, "done");
			assert.deepStrictEqual(env.data, { count: 1 });
			assert.deepStrictEqual(env.nextActions, ["next"]);
			assert.strictEqual(env.error, undefined);
		});

		test("dataとnextActions省略時はフィールド自体が出力されない", () => {
			const env = createOkEnvelope("done");
			assert.strictEqual("data" in env, false);
			assert.strictEqual("nextActions" in env, false);
		});

		test("空のnextActions配列はフィールドが出力されない", () => {
			const env = createOkEnvelope("done", undefined, []);
			assert.strictEqual("nextActions" in env, false);
		});
	});

	suite("createErrorEnvelope", () => {
		test("失敗エンベロープに ok:false と error.code/error.message が含まれる", () => {
			const env = createErrorEnvelope("failed", ToolErrorCode.InvalidPath, "bad path");
			assert.strictEqual(env.schemaVersion, TOOL_SCHEMA_VERSION);
			assert.strictEqual(env.ok, false);
			assert.strictEqual(env.summary, "failed");
			assert.deepStrictEqual(env.error, { code: "invalid_path", message: "bad path" });
		});

		test("失敗エンベロープにもnextActionsを含められる（リカバリ誘導）", () => {
			const env = createErrorEnvelope("failed", ToolErrorCode.Cancelled, "cancelled", ["retry"]);
			assert.deepStrictEqual(env.nextActions, ["retry"]);
		});
	});

	suite("serializeEnvelope", () => {
		test("シリアライズ結果はJSONとしてパース可能でエンベロープ構造を保つ", () => {
			const env = createOkEnvelope("done", { files: ["a.md"] }, ["act"]);
			const parsed = JSON.parse(serializeEnvelope(env));
			assert.strictEqual(parsed.schemaVersion, TOOL_SCHEMA_VERSION);
			assert.strictEqual(parsed.ok, true);
			assert.strictEqual(parsed.summary, "done");
			assert.deepStrictEqual(parsed.data, { files: ["a.md"] });
			assert.deepStrictEqual(parsed.nextActions, ["act"]);
		});
	});
});
