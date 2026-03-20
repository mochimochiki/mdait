import * as assert from "node:assert";
import { TmxStore } from "../../../core/tm/tmx-store";
import { TranslationMemoryCleanupService } from "../../../core/tm/translation-memory-cleanup-service";
import type { CurrentPrimaryUnit, TranslationUnitRecord } from "../../../core/tm/types";

function createRecord(
	tuid: string,
	primarySeg: string,
	primaryUnitHash: string,
	targetSeg: string,
): TranslationUnitRecord {
	return {
		tuid,
		variants: new Map([
			[
				"en",
				{
					seg: primarySeg,
					unitPath: "docs/source.md",
					unitHash: primaryUnitHash,
				},
			],
			[
				"ja",
				{
					seg: targetSeg,
					unitPath: "docs/source.ja.md",
					unitHash: `${primaryUnitHash}-ja`,
				},
			],
		]),
	};
}

suite("TranslationMemoryCleanupService", () => {
	test("unitHash が変わっても primary本文が現存するTUは保持される", () => {
		const store = new TmxStore("en");
		store.upsertTranslationUnit(
			createRecord("tu-keep", "Install the extension.", "old-hash-1", "拡張機能をインストールします。"),
		);
		store.upsertTranslationUnit(
			createRecord("tu-delete", "Remove the obsolete file.", "old-hash-2", "古いファイルを削除します。"),
		);

		const currentPrimaryUnits: CurrentPrimaryUnit[] = [
			{
				unitPath: "docs/source.md",
				unitHash: "new-hash-1",
				content: "Install the extension.",
			},
		];

		const service = new TranslationMemoryCleanupService(store, "en");
		const result = service.cleanup(currentPrimaryUnits);

		assert.strictEqual(result.candidateCount, 2);
		assert.deepStrictEqual(result.keptTuids, ["tu-keep"]);
		assert.deepStrictEqual(result.deletedTuids, ["tu-delete"]);
		assert.ok(store.findByTuid("tu-keep"));
		assert.strictEqual(store.findByTuid("tu-delete"), undefined);
	});

	test("currentPrimaryUnits が空でも primary source が空になったケースとして obsolete TU を削除できる", () => {
		const store = new TmxStore("en");
		store.upsertTranslationUnit(
			createRecord("tu-delete-all", "Install the extension.", "old-hash-1", "拡張機能をインストールします。"),
		);

		const service = new TranslationMemoryCleanupService(store, "en");
		const result = service.cleanup([]);

		assert.strictEqual(result.candidateCount, 1);
		assert.deepStrictEqual(result.keptTuids, []);
		assert.deepStrictEqual(result.deletedTuids, ["tu-delete-all"]);
		assert.strictEqual(store.findByTuid("tu-delete-all"), undefined);
	});

	test("旧文が新文に部分一致するだけなら obsolete TU を保持しない", () => {
		const store = new TmxStore("en");
		store.upsertTranslationUnit(
			createRecord("tu-delete-partial", "Install the extension", "old-hash-1", "拡張機能をインストール"),
		);

		const service = new TranslationMemoryCleanupService(store, "en");
		const result = service.cleanup([
			{
				unitPath: "docs/source.md",
				unitHash: "new-hash-1",
				content: "Install the extension manually before restart.",
			},
		]);

		assert.deepStrictEqual(result.keptTuids, []);
		assert.deepStrictEqual(result.deletedTuids, ["tu-delete-partial"]);
		assert.strictEqual(store.findByTuid("tu-delete-partial"), undefined);
	});
});
