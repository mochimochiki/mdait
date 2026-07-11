/**
 * 孤立ユニットモデル（独立ユニット・isolate・一次受け）のテスト。
 * - 独立ユニット（fromなしの永続マーカー / need:isolate）のパススルー保護
 * - マーカーなし孤立ターゲットの need:review 一次受けと冪等性
 * - from dangling の orphanTargetPolicy 分岐（delete/verify）
 * - レガシー need（keep/backfill）のマイグレーション
 * - isolate source の伝播停止（空target非生成・syncNew除外・revise凍結）
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SectionMatcher } from "../../../../commands/sync/section-matcher";
import { normalizeLegacyNeeds, syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

function unitOf(content: string, marker: MdaitMarker | null = null, title = ""): MdaitUnit {
	const m = marker ?? new MdaitMarker(calculateHash(content));
	return new MdaitUnit(m, title, 2, content, 0, 10);
}

suite("独立ユニット（訳文役割の孤立）のパススルー保護", () => {
	test("独立ユニットはsourceと対応付けされず孤立ターゲットとしてパススルーされる", () => {
		const source = unitOf("## 新しいセクション\n\n日本語本文。");
		const independent = unitOf("## English-only section\n\nIndependent content.");
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([source], [independent], new Set([independent]));

		// 独立ユニットがsourceとペアにならないこと
		const independentPair = matchResult.find((p) => p.target === independent);
		assert.ok(independentPair);
		assert.strictEqual(independentPair.source, null);

		// sourceは新規追加として扱われること
		const sourcePair = matchResult.find((p) => p.source === source);
		assert.ok(sourcePair);
		assert.strictEqual(sourcePair.target, null);
	});

	test("独立ユニットと通常ユニットが混在しても対応付けが崩れない", () => {
		const src1 = unitOf("## A\n\n本文A", new MdaitMarker("srcA"));
		const src2 = unitOf("## B\n\n本文B", new MdaitMarker("srcB"));
		const tgtA = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA"));
		const independent = unitOf("## Extra\n\nIndependent", new MdaitMarker("ind1"));
		const tgtB = unitOf("## B(en)\n\nContent B", new MdaitMarker("tgtB", "srcB"));

		const matcher = new SectionMatcher();
		const matchResult = matcher.match([src1, src2], [tgtA, independent, tgtB], new Set([independent]));

		assert.strictEqual(matchResult.find((p) => p.source === src1)?.target, tgtA);
		assert.strictEqual(matchResult.find((p) => p.source === src2)?.target, tgtB);
		const independentPair = matchResult.find((p) => p.target === independent);
		assert.ok(independentPair);
		assert.strictEqual(independentPair.source, null);
	});

	test("素hashの独立ユニットはpolicy=deleteでも不変で保持されること", () => {
		const independent = unitOf("## Extra\n\nIndependent content.", new MdaitMarker("ind1"));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(
			[{ source: null, target: independent }],
			"delete",
			new Set([independent]),
		);
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0], independent);
		assert.strictEqual(result.units[0].marker?.need, null);
		assert.strictEqual(result.units[0].marker?.from, null);
		assert.strictEqual(result.orphanKept, 1);
		assert.strictEqual(result.orphanDeleted, 0);
	});

	test("need:isolate のターゲット（from付き）は独立ユニット集合に含めなくてもpolicy=deleteで保持されること", () => {
		// from付きisolateは通常Phase 1でペア維持されるが、原文消失で孤立してもisolate自体が保持を保証する
		const isolated = unitOf("## Local\n\nLocal content.", new MdaitMarker("iso1", "gone-source", "isolate"));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets([{ source: null, target: isolated }], "delete");
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "isolate");
		assert.strictEqual(result.orphanKept, 1);
	});

	test("from付きneed:isolateのターゲットはPhase 1（from一致）でペア維持されること", () => {
		// isolateは「下流に出さない」であって上流リンクの切断ではない（独立ユニット集合には入れない）
		const source = unitOf("## A\n\n本文A", new MdaitMarker("srcA"));
		const isolated = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA", "isolate"));
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([source], [isolated]);
		const pair = matchResult.find((p) => p.source === source);
		assert.ok(pair);
		assert.strictEqual(pair.target, isolated, "上流ペアが維持されること");
	});

	test("fromなし need:review（一次受け保留）のターゲットも保持されること", () => {
		const pending = unitOf("## Pending\n\nPending content.", new MdaitMarker("pend1", null, "review"));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets([{ source: null, target: pending }], "delete", new Set([pending]));
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "review");
		assert.strictEqual(result.orphanKept, 1);
	});

	test("独立ユニットは2回目のsyncでも不変（冪等性）", () => {
		const independent = unitOf("## Extra\n\nIndependent content.", new MdaitMarker("ind1"));
		const matcher = new SectionMatcher();
		const first = matcher.createSyncedTargets(
			[{ source: null, target: independent }],
			"delete",
			new Set([independent]),
		);
		const keptUnit = first.units[0];
		const second = matcher.createSyncedTargets([{ source: null, target: keptUnit }], "delete", new Set([keptUnit]));
		assert.strictEqual(second.units.length, 1);
		assert.strictEqual(second.units[0].marker?.need, null);
		assert.strictEqual(second.units[0].content, independent.content);
		assert.strictEqual(second.orphanKept, 1);
	});
});

suite("マーカーなし孤立ターゲットの一次受け（need:review）", () => {
	test("独立ユニット集合に含まれないfromなし孤立targetにneed:reviewが付与されること", () => {
		// ensureMdaitMarkerHash が素hashを合成した直後の状態を模す
		const content = "## Unmanaged\n\nUnmanaged content.";
		const orphan = unitOf(content, new MdaitMarker(calculateHash(content)));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets([{ source: null, target: orphan }], "delete");
		assert.strictEqual(result.units.length, 1, "policy=deleteでも削除されないこと（安全側）");
		assert.strictEqual(result.units[0].marker?.need, "review");
		assert.strictEqual(result.units[0].marker?.from, null, "fromは付けないこと");
		assert.strictEqual(result.orphanReviewed, 1);
		assert.strictEqual(result.orphanDeleted, 0);
	});

	test("一次受け済みユニットは次回syncで独立ユニット扱いとなり不変（冪等性）", () => {
		const content = "## Unmanaged\n\nUnmanaged content.";
		const orphan = unitOf(content, new MdaitMarker(calculateHash(content)));
		const matcher = new SectionMatcher();
		const first = matcher.createSyncedTargets([{ source: null, target: orphan }], "delete");
		const reviewed = first.units[0];

		// 2回目: 永続化された「fromなし need:review」は独立ユニット集合に入る
		const second = matcher.createSyncedTargets([{ source: null, target: reviewed }], "delete", new Set([reviewed]));
		assert.strictEqual(second.units.length, 1);
		assert.strictEqual(second.units[0].marker?.need, "review");
		assert.strictEqual(second.orphanKept, 1);
		assert.strictEqual(second.orphanReviewed, 0);
	});
});

suite("from dangling（管理済み孤立）のポリシー分岐", () => {
	function danglingMatchResult() {
		const target = unitOf("## Extra section\n\nEnglish only content.", new MdaitMarker("abc", "gone-source"));
		return [{ source: null, target }];
	}

	test("delete: fromが残る孤立ターゲットは削除される", () => {
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(danglingMatchResult(), "delete");
		assert.strictEqual(result.units.length, 0);
		assert.strictEqual(result.orphanDeleted, 1);
	});

	test("verify: fromが残る孤立ターゲットに need:verify-deletion が付与され保持される", () => {
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(danglingMatchResult(), "verify");
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "verify-deletion");
		assert.strictEqual(result.orphanVerified, 1);
	});

	test("fromなし need:verify-deletion（レガシー）はdeleteポリシーで削除されること（現行挙動維持）", () => {
		const target = unitOf("## Legacy\n\nLegacy content.", new MdaitMarker("abc", null, "verify-deletion"));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets([{ source: null, target }], "delete");
		assert.strictEqual(result.units.length, 0);
		assert.strictEqual(result.orphanDeleted, 1);
	});

	test("fromなし need:verify-deletion（レガシー）はverifyポリシーで維持されること", () => {
		const target = unitOf("## Legacy\n\nLegacy content.", new MdaitMarker("abc", null, "verify-deletion"));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets([{ source: null, target }], "verify");
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "verify-deletion");
		assert.strictEqual(result.orphanVerified, 1);
	});
});

suite("レガシーneedのマイグレーション（normalizeLegacyNeeds）", () => {
	test("need:keep はneed除去され素hashの独立ユニットになること", () => {
		const unit = unitOf("## Kept\n\nKept content.", new MdaitMarker("abc", null, "keep"));
		normalizeLegacyNeeds([unit]);
		assert.strictEqual(unit.marker?.need, null);
		assert.strictEqual(unit.marker?.from, null);
		assert.strictEqual(unit.marker?.hash, "abc");
	});

	test("need:backfill は need:review にマイグレーションされること", () => {
		const unit = unitOf("## Placeholder\n\nPlaceholder content.", new MdaitMarker("abc", null, "backfill"));
		normalizeLegacyNeeds([unit]);
		assert.strictEqual(unit.marker?.need, "review");
	});

	test("他のneedやfromは変更されないこと（冪等）", () => {
		const translate = unitOf("## A\n\nA", new MdaitMarker("a1", "s1", "translate"));
		const isolate = unitOf("## B\n\nB", new MdaitMarker("b1", null, "isolate"));
		const plain = unitOf("## C\n\nC", new MdaitMarker("c1"));
		normalizeLegacyNeeds([translate, isolate, plain]);
		normalizeLegacyNeeds([translate, isolate, plain]);
		assert.strictEqual(translate.marker?.need, "translate");
		assert.strictEqual(translate.marker?.from, "s1");
		assert.strictEqual(isolate.marker?.need, "isolate");
		assert.strictEqual(plain.marker?.need, null);
	});
});

suite("isolate source の伝播停止", () => {
	test("createSyncedTargets: 未マッチのisolate sourceから空targetを生成しないこと", () => {
		const isolateSource = unitOf("## Internal\n\nInternal note.", new MdaitMarker("iso1", null, "isolate"));
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets([{ source: isolateSource, target: null }], "delete");
		assert.strictEqual(result.units.length, 0);
	});

	test("match: isolate source は順序ベース推定（Phase 2）でtargetと対応しないこと", () => {
		const isolateSource = unitOf("## Internal\n\nInternal note.", new MdaitMarker("iso1", null, "isolate"));
		const target = unitOf("## Something\n\nSome target content.", new MdaitMarker("tgt1"));
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([isolateSource], [target]);

		const sourcePair = matchResult.find((p) => p.source === isolateSource);
		assert.ok(sourcePair, "hash更新のためisolate sourceもペアに含まれること");
		assert.strictEqual(sourcePair.target, null);

		const targetPair = matchResult.find((p) => p.target === target);
		assert.ok(targetPair);
		assert.strictEqual(targetPair.source, null);
	});

	test("match: isolate source も from 一致（Phase 1）ならペア成立すること", () => {
		const isolateSource = unitOf("## Internal\n\nInternal note.", new MdaitMarker("iso1", null, "isolate"));
		const target = unitOf("## Internal(en)\n\nTranslated note.", new MdaitMarker("tgt1", "iso1"));
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([isolateSource], [target]);

		const pair = matchResult.find((p) => p.source === isolateSource);
		assert.ok(pair);
		assert.strictEqual(pair.target, target);
	});
});

suite("sync CoreProc 統合（独立ユニット・isolate・一次受け）", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-orphan-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function initConfig(sync?: Record<string, unknown>): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		const obj: Record<string, unknown> = {
			transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
			primaryLang: "ja",
		};
		if (sync) {
			obj.sync = sync;
		}
		fs.writeFileSync(configPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		return config;
	}

	function parseUnits(filePath: string) {
		const content = fs.readFileSync(filePath, "utf-8");
		return markdownParser.parse(content, Configuration.getInstance()).units;
	}

	test("syncNew: need:isolate のsourceユニットはtargetファイルに出力されないこと", async () => {
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			[
				"<!-- mdait iso123 need:isolate -->",
				"## 内部メモ",
				"",
				"内部限定の本文。",
				"",
				"## 概要",
				"",
				"公開する本文。",
				"",
			].join("\n"),
			"utf-8",
		);

		const diff = await syncNew_CoreProc(sourceFile, targetFile, config);

		const targetUnits = parseUnits(targetFile);
		assert.strictEqual(targetUnits.length, 1, "isolateユニットは出力されないこと");
		assert.strictEqual(targetUnits[0].title, "概要");
		assert.strictEqual(diff.added, 1, "isolateユニットは追加数に数えないこと");

		// source側のisolateマーカーは維持されること
		const sourceUnits = parseUnits(sourceFile);
		assert.strictEqual(sourceUnits[0].marker?.need, "isolate");
	});

	test("sync: マーカーなしで追記された孤立targetがneed:reviewで一次受けされ、2回目syncで不変（冪等）", async () => {
		const config = await initConfig({ orphanTargetPolicy: "delete" });
		fs.writeFileSync(sourceFile, ["## 概要", "", "公開する本文。", ""].join("\n"), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// targetにマーカーなしのセクションを追記する（管理外コンテンツ）
		fs.appendFileSync(targetFile, ["", "## Local addendum", "", "Manually written content.", ""].join("\n"), "utf-8");

		await sync_CoreProc(sourceFile, targetFile, config);

		const afterFirst = parseUnits(targetFile);
		const addendum = afterFirst.find((u) => u.title === "Local addendum");
		assert.ok(addendum, "policy=deleteでも削除されず保持されること");
		assert.strictEqual(addendum.marker?.need, "review");
		assert.strictEqual(addendum.marker?.from, null);

		// 2回目のsync: 永続化された「fromなしneed:review」は独立ユニットとして不変
		const firstContent = fs.readFileSync(targetFile, "utf-8");
		const secondDiff = await sync_CoreProc(sourceFile, targetFile, config);
		const secondContent = fs.readFileSync(targetFile, "utf-8");
		assert.strictEqual(secondContent, firstContent, "2回目syncでファイルが変化しないこと");
		assert.strictEqual(secondDiff.kept, 1, "2回目は独立ユニットとして保持されること");
		assert.strictEqual(secondDiff.orphanReviewed ?? 0, 0);
	});

	test("sync: レガシーneed:keepのユニットが素hash独立ユニットへマイグレーションされ保持されること", async () => {
		const config = await initConfig({ orphanTargetPolicy: "delete" });
		fs.writeFileSync(sourceFile, ["## 概要", "", "公開する本文。", ""].join("\n"), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		fs.appendFileSync(
			targetFile,
			["", "<!-- mdait keep123 need:keep -->", "## Kept section", "", "Kept content.", ""].join("\n"),
			"utf-8",
		);

		await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		const kept = units.find((u) => u.title === "Kept section");
		assert.ok(kept, "keepユニットが保持されること");
		assert.strictEqual(kept.marker?.need, null, "need:keepが除去されること");
		assert.strictEqual(kept.marker?.from, null);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8").includes("need:keep"), false);
	});

	test("sync: レガシーneed:backfillのsourceプレースホルダがneed:reviewへマイグレーションされること", async () => {
		const config = await initConfig();
		const body = "Backfilled content.";
		const placeholderHash = "bf123";
		fs.writeFileSync(
			sourceFile,
			[`<!-- mdait ${placeholderHash} need:backfill -->`, "## Placeholder", "", body, ""].join("\n"),
			"utf-8",
		);
		fs.writeFileSync(
			targetFile,
			[`<!-- mdait tgt123 from:${placeholderHash} -->`, "## Placeholder", "", body, ""].join("\n"),
			"utf-8",
		);

		await sync_CoreProc(sourceFile, targetFile, config);

		const sourceUnits = parseUnits(sourceFile);
		assert.strictEqual(sourceUnits[0].marker?.need, "review", "backfill→reviewへ移行すること");
	});

	test("sync: ペア済みisolate sourceの本文変更でreviseが付かないこと（hash/fromは更新）", async () => {
		const config = await initConfig();
		fs.writeFileSync(sourceFile, ["## 概要", "", "公開する本文。", ""].join("\n"), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// source側をisolate化し、target側は翻訳済み（need除去）とする
		const initialSourceUnits = parseUnits(sourceFile);
		const originalHash = initialSourceUnits[0].marker?.hash;
		assert.ok(originalHash);
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		fs.writeFileSync(
			sourceFile,
			sourceContent
				.replace(`<!-- mdait ${originalHash} -->`, `<!-- mdait ${originalHash} need:isolate -->`)
				.replace("公開する本文。", "公開する本文。（更新）"),
			"utf-8",
		);
		const targetContent = fs.readFileSync(targetFile, "utf-8");
		fs.writeFileSync(targetFile, targetContent.replace(" need:translate", ""), "utf-8");

		await sync_CoreProc(sourceFile, targetFile, config);

		const sourceUnits = parseUnits(sourceFile);
		const targetUnits = parseUnits(targetFile);
		const newSourceHash = sourceUnits[0].marker?.hash;
		assert.ok(newSourceHash);
		assert.notStrictEqual(newSourceHash, originalHash, "source hashが更新されること");
		assert.strictEqual(sourceUnits[0].marker?.need, "isolate", "isolateが維持されること");
		assert.strictEqual(targetUnits.length, 1);
		assert.strictEqual(targetUnits[0].marker?.from, newSourceHash, "fromは最新化されること");
		assert.strictEqual(targetUnits[0].marker?.need, null, "reviseが付かないこと（凍結）");
	});

	test("sync: from付きisolate targetは上流ペアを維持し、source変更でもisolateが上書きされないこと", async () => {
		const config = await initConfig({ orphanTargetPolicy: "delete" });
		fs.writeFileSync(sourceFile, ["## 概要", "", "公開する本文。", ""].join("\n"), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// target側を翻訳済み＋isolate化し（下流に出さない宣言）、source本文を変更する
		const initialSourceUnits = parseUnits(sourceFile);
		const originalHash = initialSourceUnits[0].marker?.hash;
		assert.ok(originalHash);
		const targetContent = fs.readFileSync(targetFile, "utf-8");
		fs.writeFileSync(targetFile, targetContent.replace(" need:translate", " need:isolate"), "utf-8");
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		fs.writeFileSync(sourceFile, sourceContent.replace("公開する本文。", "公開する本文。（更新）"), "utf-8");

		await sync_CoreProc(sourceFile, targetFile, config);

		const sourceUnits = parseUnits(sourceFile);
		const targetUnits = parseUnits(targetFile);
		const newSourceHash = sourceUnits[0].marker?.hash;
		assert.ok(newSourceHash);
		assert.notStrictEqual(newSourceHash, originalHash, "source hashが更新されること");
		assert.strictEqual(targetUnits.length, 1, "重複ユニットが生成されないこと（上流ペア維持）");
		assert.strictEqual(targetUnits[0].marker?.from, newSourceHash, "fromは最新化されること");
		assert.strictEqual(targetUnits[0].marker?.need, "isolate", "reviseで上書きされずisolateが維持されること");
	});
});
