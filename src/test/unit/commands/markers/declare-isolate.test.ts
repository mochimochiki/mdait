// isolate宣言コマンド（UX-R1: isolate宣言UI）の検証。
// 訳文ユニットに need:isolate を宣言する declareIsolateForFile を対象とする。
// 解除（undeclare）は resolve-need.ts の既存経路（needs:["isolate"]）を再利用するためここでは扱わない。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { declareIsolateForFile } from "../../../../commands/markers/declare-isolate";
import { resolveNeedForFile, unitTargets } from "../../../../commands/markers/resolve-need";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

suite("declareIsolateForFile（need:isolate宣言）", () => {
	let tempDir: string;
	let targetFile: string;

	const TARGET_CONTENT = `<!-- mdait tgtA from:srcA -->
## Section A

Content A.

<!-- mdait tgtB from:srcB need:review -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:isolate -->
## Section C

Content C.
`;

	async function initConfig(markers: Record<string, unknown> = {}): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [
					{
						sourceDir: "ja",
						targetDir: "en",
						sourceLang: "ja",
						targetLang: "en",
					},
				],
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
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-declare-isolate-"));
		__vscodeMockWorkspaceRoot = tempDir;
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("needの無い完了済みユニットにneed:isolateが宣言される。hash/from/本文は不変", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await declareIsolateForFile(targetFile, "tgtA", config);

		assert.strictEqual(result.declared, true);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtA from:srcA need:isolate -->"));
		assert.ok(written.includes("Content A."));
	});

	test("存在しないhashはdeclared falseでreason not-found", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await declareIsolateForFile(targetFile, "zzz", config);

		assert.strictEqual(result.declared, false);
		assert.strictEqual(result.reason, "not-found");
	});

	test("既にneedがあるユニットは宣言をスキップする（他の判断待ちを踏み潰さない）", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await declareIsolateForFile(targetFile, "tgtB", config);

		assert.strictEqual(result.declared, false);
		assert.strictEqual(result.reason, "need-already-set");
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtB from:srcB need:review -->"), "既存のneedが変更されないこと");
	});

	test("2回目の宣言はneed-already-setになる（冪等性）", async () => {
		const config = await initConfig();
		writeTarget();
		const first = await declareIsolateForFile(targetFile, "tgtA", config);
		assert.strictEqual(first.declared, true);

		const second = await declareIsolateForFile(targetFile, "tgtA", config);
		assert.strictEqual(second.declared, false);
		assert.strictEqual(second.reason, "need-already-set");
	});

	test("宣言後にresolveNeedForFile(needs:[isolate])で解除できる", async () => {
		const config = await initConfig();
		writeTarget();
		await declareIsolateForFile(targetFile, "tgtA", config);

		const resolveResult = await resolveNeedForFile(targetFile, config, {
			targets: unitTargets(["tgtA"]),
			needs: ["isolate"],
		});

		assert.strictEqual(resolveResult.resolved.length, 1);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"), "isolateが解除されneedなしに戻ること");
	});

	test("externalマーカーモードではストアにneed:isolateが設定され本文は不変", async () => {
		const config = await initConfig({ mode: "external" });
		const externalContent = "## Section A\n\nContent A.\n";
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
			need: "",
		});

		const result = await declareIsolateForFile(targetFile, "tgtA", config);

		assert.strictEqual(result.declared, true);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), externalContent, "本文にマーカーは埋め込まれないこと");
		const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
		assert.strictEqual(entries[0].need, "isolate");
		assert.strictEqual(entries[0].hash, "tgtA");
		assert.strictEqual(entries[0].from, "srcA");
	});
});
