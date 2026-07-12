// verify-deletion ユニットの削除コマンド（UX-R1: Keep/Delete 2択化）の検証。
// hash/from の書き換えに留まる resolve-need.ts と異なり、ユニット自体をドキュメントから除去する。
// embedded/external 両モード、安全弁（need:verify-deletion以外は削除不可）、
// external モードでの unit-state ストア末尾エントリの刈り取りを検証する。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteUnitFromFile } from "../../../../commands/markers/delete-unit";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

suite("deleteUnitFromFile（verify-deletionユニットの削除）", () => {
	let tempDir: string;
	let targetFile: string;

	const TARGET_CONTENT = `<!-- mdait tgtA from:srcA need:verify-deletion -->
## Section A

Content A.

<!-- mdait tgtB from:srcB -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:review -->
## Section C

Content C.
`;

	async function initConfig(markers: Record<string, unknown> = {}): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				...(Object.keys(markers).length > 0 ? { markers } : {}),
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
	}

	function writeTarget(content = TARGET_CONTENT): void {
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(targetFile, content, "utf-8");
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-delete-unit-"));
		__vscodeMockWorkspaceRoot = tempDir;
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("need:verify-deletionのユニットは本文から除去される", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await deleteUnitFromFile(targetFile, "tgtA", config);

		assert.strictEqual(result.deleted, true);
		assert.strictEqual(result.hash, "tgtA");
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("tgtA"), "削除対象のマーカーが残っていないこと");
		assert.ok(!written.includes("Content A."), "削除対象の本文が残っていないこと");
		assert.ok(written.includes("Content B."), "他ユニットの本文は保持されること");
		assert.ok(written.includes("Content C."), "他ユニットの本文は保持されること");
	});

	test("存在しないhashはdeleted falseでreason not-found", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await deleteUnitFromFile(targetFile, "zzz", config);

		assert.strictEqual(result.deleted, false);
		assert.strictEqual(result.reason, "not-found");
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), TARGET_CONTENT, "ファイルは変更されないこと");
	});

	test("need:verify-deletion以外のユニットは削除できない（安全弁）", async () => {
		const config = await initConfig();
		writeTarget();

		const reviewResult = await deleteUnitFromFile(targetFile, "tgtC", config);
		assert.strictEqual(reviewResult.deleted, false);
		assert.strictEqual(reviewResult.reason, "not-verify-deletion");

		const completeResult = await deleteUnitFromFile(targetFile, "tgtB", config);
		assert.strictEqual(completeResult.deleted, false);
		assert.strictEqual(completeResult.reason, "not-verify-deletion");

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), TARGET_CONTENT, "ファイルは変更されないこと");
	});

	test("2回目の削除はnot-foundになる（冪等性）", async () => {
		const config = await initConfig();
		writeTarget();
		const first = await deleteUnitFromFile(targetFile, "tgtA", config);
		assert.strictEqual(first.deleted, true);

		const second = await deleteUnitFromFile(targetFile, "tgtA", config);
		assert.strictEqual(second.deleted, false);
		assert.strictEqual(second.reason, "not-found");
	});

	test("externalマーカーモードでは本文中のマーカーなしユニットが削除され、ストアの末尾エントリも刈り取られる", async () => {
		const config = await initConfig({ mode: "external" });
		const externalContent = "## Section A\n\nContent A.\n\n## Section B\n\nContent B.\n\n## Section C\n\nContent C.\n";
		writeTarget(externalContent);

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({ path: "en/doc.md", order: 0, level: 2, titleHash: "", hash: "tgtA", from: "srcA", need: "verify-deletion" });
		store.setEntry({ path: "en/doc.md", order: 1, level: 2, titleHash: "", hash: "tgtB", from: "srcB", need: "" });
		store.setEntry({ path: "en/doc.md", order: 2, level: 2, titleHash: "", hash: "tgtC", from: "srcC", need: "review" });

		const result = await deleteUnitFromFile(targetFile, "tgtA", config);

		assert.strictEqual(result.deleted, true);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("Content A."), "削除対象の本文が本文から除去されること");
		assert.ok(written.includes("Content B."));
		assert.ok(written.includes("Content C."));

		const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
		assert.strictEqual(entries.length, 2, "削除後は2エントリのみ残ること（末尾の古いエントリが刈り取られること）");
		assert.deepStrictEqual(
			entries.map((e) => e.hash),
			["tgtB", "tgtC"],
		);
		assert.deepStrictEqual(
			entries.map((e) => e.order),
			[0, 1],
			"order が詰め直されること",
		);
	});
});
