import * as assert from "node:assert";
import {
	applyBackfillTranslation,
	collectBackfillPairs,
} from "../../../../commands/trans/backfill";
import { SectionMatcher } from "../../../../commands/sync/section-matcher";
import { syncMarkerPair } from "../../../../commands/sync/marker-sync";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

function unitOf(content: string, marker: MdaitMarker | null = null, title = ""): MdaitUnit {
	const m = marker ?? new MdaitMarker(calculateHash(content));
	return new MdaitUnit(m, title, 2, content, 0, 10);
}

suite("backfill（逆方向埋め戻し）", () => {
	suite("SectionMatcher backfill ポリシー", () => {
		test("孤立ターゲットの from が自ユニットのハッシュに設定され保持される", () => {
			const content = "## English only\n\nContent.";
			const hash = calculateHash(content);
			const orphan = unitOf(content, new MdaitMarker(hash, "gone-source"));
			const matcher = new SectionMatcher();
			const result = matcher.createSyncedTargets([{ source: null, target: orphan }], "backfill");
			assert.strictEqual(result.units.length, 1);
			assert.strictEqual(result.backfillTargets.length, 1);
			assert.strictEqual(result.units[0].marker?.from, hash);
			assert.strictEqual(result.units[0].marker?.need, null);
		});

		test("プレースホルダがターゲット本文と同一内容・need:backfillで生成される", () => {
			const content = "## English only\n\nContent.";
			const hash = calculateHash(content);
			const orphan = unitOf(content, new MdaitMarker(hash, "gone-source"));
			const matcher = new SectionMatcher();
			const matchResult = [{ source: null, target: orphan }];
			const synced = matcher.createSyncedTargets(matchResult, "backfill");

			const sourceUnits: MdaitUnit[] = [];
			const inserted = matcher.insertBackfillPlaceholders(
				sourceUnits,
				[orphan],
				matchResult,
				synced.backfillTargets,
			);
			assert.strictEqual(inserted, 1);
			assert.strictEqual(sourceUnits.length, 1);
			assert.strictEqual(sourceUnits[0].content, content);
			assert.strictEqual(sourceUnits[0].marker?.hash, hash);
			assert.strictEqual(sourceUnits[0].marker?.from, null);
			assert.strictEqual(sourceUnits[0].marker?.need, "backfill");
		});

		test("プレースホルダは直前の対応済みユニットの直後に挿入される", () => {
			const srcA = unitOf("## A\n\n本文A", new MdaitMarker("srcA"));
			const srcC = unitOf("## C\n\n本文C", new MdaitMarker("srcC"));
			const tgtA = unitOf("## A(en)\n\nA", new MdaitMarker("tgtA", "srcA"));
			const orphanContent = "## B(en)\n\nEnglish only B.";
			const orphanHash = calculateHash(orphanContent);
			const orphanB = unitOf(orphanContent, new MdaitMarker(orphanHash, null));
			const tgtC = unitOf("## C(en)\n\nC", new MdaitMarker("tgtC", "srcC"));

			const matcher = new SectionMatcher();
			const sourceUnits = [srcA, srcC];
			const targetUnits = [tgtA, orphanB, tgtC];
			const matchResult = matcher.match(sourceUnits, targetUnits);
			const synced = matcher.createSyncedTargets(matchResult, "backfill");
			const inserted = matcher.insertBackfillPlaceholders(
				sourceUnits,
				targetUnits,
				matchResult,
				synced.backfillTargets,
			);
			assert.strictEqual(inserted, 1);
			// srcA の直後に挿入される
			assert.strictEqual(sourceUnits.length, 3);
			assert.strictEqual(sourceUnits[0], srcA);
			assert.strictEqual(sourceUnits[1].marker?.need, "backfill");
			assert.strictEqual(sourceUnits[2], srcC);
		});

		test("同一ハッシュのソースユニットが既に存在する場合は挿入しない（冪等性）", () => {
			const content = "## English only\n\nContent.";
			const hash = calculateHash(content);
			const orphan = unitOf(content, new MdaitMarker(hash, hash));
			const existingPlaceholder = unitOf(content, new MdaitMarker(hash, null, "backfill"));
			const matcher = new SectionMatcher();
			const inserted = matcher.insertBackfillPlaceholders(
				[existingPlaceholder],
				[orphan],
				[{ source: existingPlaceholder, target: orphan }],
				[orphan],
			);
			assert.strictEqual(inserted, 0);
		});
	});

	suite("collectBackfillPairs / applyBackfillTranslation", () => {
		test("need:backfill ユニットと from 参照でペアが解決される", () => {
			const content = "## English only\n\nContent.";
			const hash = calculateHash(content);
			const placeholder = unitOf(content, new MdaitMarker(hash, null, "backfill"));
			const target = unitOf(content, new MdaitMarker(hash, hash));
			const pairs = collectBackfillPairs([placeholder], [target]);
			assert.strictEqual(pairs.length, 1);
			assert.strictEqual(pairs[0].source, placeholder);
			assert.strictEqual(pairs[0].target, target);
		});

		test("対応する訳文ユニットがないプレースホルダは対象外", () => {
			const placeholder = unitOf("## X\n\nX", new MdaitMarker("hashX", null, "backfill"));
			const pairs = collectBackfillPairs([placeholder], []);
			assert.strictEqual(pairs.length, 0);
		});

		test("翻訳適用で原文に need:review が残り、訳文の from が新ハッシュになる", () => {
			const content = "## English only\n\nContent.";
			const hash = calculateHash(content);
			const placeholder = unitOf(content, new MdaitMarker(hash, null, "backfill"));
			const target = unitOf(content, new MdaitMarker(hash, hash));
			const translated = "## 日本語のみ\n\n内容。";

			applyBackfillTranslation({ source: placeholder, target }, translated);

			const newHash = calculateHash(translated);
			assert.strictEqual(placeholder.content, translated);
			assert.strictEqual(placeholder.marker.hash, newHash);
			assert.strictEqual(placeholder.marker.need, "review");
			assert.strictEqual(placeholder.marker.from, null);
			assert.strictEqual(target.marker.from, newHash);
		});
	});

	suite("backfill→trans→sync の定常状態（結合）", () => {
		test("3手順後に対称ペアが成立し、以後のsyncで無変更", () => {
			// 初期状態: ソースに1ユニット、ターゲットに対応ユニット＋英語のみの孤立ユニット
			const srcA = unitOf("## A\n\n本文A", new MdaitMarker("srcA"));
			const tgtA = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA"));
			const orphanContent = "## English-only\n\nOnly in English.";
			const orphanHash = calculateHash(orphanContent);
			const orphan = unitOf(orphanContent, new MdaitMarker(orphanHash, null));

			const matcher = new SectionMatcher();

			// --- 手順1: sync (backfill) ---
			const sourceUnits = [srcA];
			const targetUnits = [tgtA, orphan];
			const match1 = matcher.match(sourceUnits, targetUnits);
			const synced1 = matcher.createSyncedTargets(match1, "backfill");
			matcher.insertBackfillPlaceholders(sourceUnits, targetUnits, match1, synced1.backfillTargets);

			assert.strictEqual(sourceUnits.length, 2);
			const placeholder = sourceUnits.find((u) => u.marker?.need === "backfill");
			assert.ok(placeholder);
			assert.strictEqual(orphan.marker.from, placeholder.marker.hash);

			// --- 手順2: trans（逆方向翻訳） ---
			const pairs = collectBackfillPairs(sourceUnits, synced1.units);
			assert.strictEqual(pairs.length, 1);
			applyBackfillTranslation(pairs[0], "## 日本語セクション\n\n英語のみだった内容の逆翻訳。");

			assert.strictEqual(placeholder.marker.need, "review");
			assert.strictEqual(orphan.marker.from, placeholder.marker.hash);

			// --- 手順3: sync（定常状態の確認） ---
			const match2 = matcher.match(sourceUnits, synced1.units);
			// 孤立ペアが存在しない（全ペアがsource+target）
			const orphanPairs = match2.filter((p) => !p.source && p.target);
			assert.strictEqual(orphanPairs.length, 0);

			// syncMarkerPairで無変更（needが増えない）
			const pairForOrphan = match2.find((p) => p.target === orphan);
			assert.ok(pairForOrphan?.source);
			const result = syncMarkerPair(
				calculateHash(pairForOrphan.source.content),
				calculateHash(orphan.content),
				pairForOrphan.source.marker,
				orphan.marker,
			);
			assert.strictEqual(result.targetMarker.need, null);
			assert.strictEqual(result.targetMarker.from, pairForOrphan.source.marker.hash);
			// 原文側の need:review は人間/エージェントの確認まで残る
			assert.strictEqual(pairForOrphan.source.marker.need, "review");
		});
	});
});
