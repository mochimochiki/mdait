import * as assert from "node:assert";
import { suite, test } from "mocha";
import { StatusItemType } from "../../../core/status/status-item";

suite("StatusItemType", () => {
	test("TermsFileタイプが定義されていること", () => {
		assert.strictEqual(StatusItemType.TermsFile, "termsFile");
	});

	test("全てのStatusItemTypeが定義されていること", () => {
		assert.strictEqual(StatusItemType.Directory, "directory");
		assert.strictEqual(StatusItemType.File, "file");
		assert.strictEqual(StatusItemType.Unit, "unit");
		assert.strictEqual(StatusItemType.TermsFile, "termsFile");
	});
});
