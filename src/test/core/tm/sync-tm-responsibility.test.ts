import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

suite("sync command TM responsibility", () => {
	test("sync は optimize/cleanup を呼ばない", () => {
		const syncCommandPath = path.resolve(__dirname, "../../../../src/commands/sync/sync-command.ts");
		const content = fs.readFileSync(syncCommandPath, "utf-8");
		assert.strictEqual(content.includes("tmOptimize"), false);
		assert.strictEqual(content.includes("cleanup"), false);
	});
});
