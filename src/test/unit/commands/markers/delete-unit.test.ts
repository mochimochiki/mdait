// verify-deletion ユニットの削除コマンド（UX-R1: Keep/Delete 2択化）の検証。
// hash/from の書き換えに留まる resolve-need.ts と異なり、ユニット自体をドキュメントから除去する。
// embedded/external 両モード、安全弁（need:verify-deletion以外は削除不可）、
// external モードでの unit-state ストア末尾エントリの刈り取りを検証する。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteAllVerifyDeletionUnits, deleteUnitFromFile } from "../../../../commands/markers/delete-unit";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { seat } from "../../helpers/unit-state";

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
		store.setEntry({ path: "en/doc.md", kind: "unit" as const, seat: seat(0), level: 2, titleHash: "", hash: "tgtA", from: "srcA", need: "verify-deletion" });
		store.setEntry({ path: "en/doc.md", kind: "unit" as const, seat: seat(1), level: 2, titleHash: "", hash: "tgtB", from: "srcB", need: "" });
		store.setEntry({ path: "en/doc.md", kind: "unit" as const, seat: seat(2), level: 2, titleHash: "", hash: "tgtC", from: "srcC", need: "review" });

		const result = await deleteUnitFromFile(targetFile, "tgtA", config);

		assert.strictEqual(result.deleted, true);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("Content A."), "削除対象の本文が本文から除去されること");
		assert.ok(written.includes("Content B."));
		assert.ok(written.includes("Content C."));

		const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
		assert.strictEqual(entries.length, 2, "削除後は2エントリのみ残ること（消えた章の行が刈り取られること）");
		assert.deepStrictEqual(
			entries.map((e) => e.hash),
			["tgtB", "tgtC"],
		);
		// 席のキーは動かない。消えた章の行だけが無くなり、残った章は元の席に座ったまま
		assert.ok(entries[0].seat < entries[1].seat, "並びは保たれること");
	});

	test("一括削除: ファイル内の全verify-deletionユニットが1回の操作で除去され、他は保持される", async () => {
		const config = await initConfig();
		const content = `<!-- mdait tgtA from:srcA need:verify-deletion -->
## Section A

Content A.

<!-- mdait tgtB from:srcB -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:verify-deletion -->
## Section C

Content C.

<!-- mdait tgtD from:srcD need:review -->
## Section D

Content D.
`;
		writeTarget(content);

		const result = await deleteAllVerifyDeletionUnits(targetFile, config);

		assert.deepStrictEqual(
			result.deleted.map((d) => d.hash),
			["tgtA", "tgtC"],
		);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("Content A."));
		assert.ok(!written.includes("Content C."));
		assert.ok(written.includes("Content B."), "確認待ちでないユニットは保持されること");
		assert.ok(written.includes("Content D."), "reviewの判断待ちは保持されること");
	});

	test("一括削除: 対象が無ければ無変更（冪等性）", async () => {
		const config = await initConfig();
		writeTarget();
		const first = await deleteAllVerifyDeletionUnits(targetFile, config);
		assert.strictEqual(first.deleted.length, 1);

		const second = await deleteAllVerifyDeletionUnits(targetFile, config);
		assert.strictEqual(second.deleted.length, 0);
		assert.strictEqual(second.changed, false);
	});

	test("一括削除: hashes指定時は列挙した集合だけが削除され、他のverify-deletionは残る", async () => {
		// 確認modalを開いている間にsyncが確認待ちを増やしても、同意した一覧の外を巻き込まない
		const config = await initConfig();
		const content = `<!-- mdait tgtA from:srcA need:verify-deletion -->
## Section A

Content A.

<!-- mdait tgtB from:srcB need:verify-deletion -->
## Section B

Content B.
`;
		writeTarget(content);

		const result = await deleteAllVerifyDeletionUnits(targetFile, config, ["tgtA"]);

		assert.deepStrictEqual(
			result.deleted.map((d) => d.hash),
			["tgtA"],
		);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("Content A."));
		assert.ok(written.includes("need:verify-deletion"), "列挙外のverify-deletionは削除されないこと");
		assert.ok(written.includes("Content B."));
	});

	test("externalマーカーモードの一括削除: 全件削除でストアの行も全て刈られ、冪等", async () => {
		const config = await initConfig({ mode: "external" });
		const externalContent = "## Section A\n\nContent A.\n\n## Section B\n\nContent B.\n";
		writeTarget(externalContent);

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: "en/doc.md",
			kind: "unit" as const, seat: seat(0),
			level: 2,
			titleHash: "",
			hash: "tgtA",
			from: "srcA",
			need: "verify-deletion",
		});
		store.setEntry({
			path: "en/doc.md",
			kind: "unit" as const, seat: seat(1),
			level: 2,
			titleHash: "",
			hash: "tgtB",
			from: "srcB",
			need: "verify-deletion",
		});

		const result = await deleteAllVerifyDeletionUnits(targetFile, config);

		assert.strictEqual(result.deleted.length, 2);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8").trim(), "", "本文が空になること");
		assert.strictEqual(
			UnitStateStore.getInstance().getEntriesByPath("en/doc.md").length,
			0,
			"最後の1ユニットまで消してもストアの行が残留しないこと",
		);

		const second = await deleteAllVerifyDeletionUnits(targetFile, config);
		assert.strictEqual(second.deleted.length, 0);
		assert.strictEqual(second.changed, false);
	});

	test("externalマーカーモードの一括削除: 部分削除では残存ユニットの行だけが残る", async () => {
		const config = await initConfig({ mode: "external" });
		const externalContent = "## Section A\n\nContent A.\n\n## Section B\n\nContent B.\n\n## Section C\n\nContent C.\n";
		writeTarget(externalContent);

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: "en/doc.md",
			kind: "unit" as const, seat: seat(0),
			level: 2,
			titleHash: "",
			hash: "tgtA",
			from: "srcA",
			need: "verify-deletion",
		});
		store.setEntry({ path: "en/doc.md", kind: "unit" as const, seat: seat(1), level: 2, titleHash: "", hash: "tgtB", from: "srcB", need: "" });
		store.setEntry({
			path: "en/doc.md",
			kind: "unit" as const, seat: seat(2),
			level: 2,
			titleHash: "",
			hash: "tgtC",
			from: "srcC",
			need: "verify-deletion",
		});

		const result = await deleteAllVerifyDeletionUnits(targetFile, config);

		assert.deepStrictEqual(
			result.deleted.map((d) => d.hash),
			["tgtA", "tgtC"],
		);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("Content B."));
		assert.ok(!written.includes("Content A."));
		assert.ok(!written.includes("Content C."));

		const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
		assert.strictEqual(entries.length, 1, "残存ユニットの行だけになること");
		assert.strictEqual(entries[0].hash, "tgtB");
		assert.strictEqual(entries[0].from, "srcB");
		assert.strictEqual(entries[0].kind, "unit", "残った章は席に座ったまま");
	});
});
