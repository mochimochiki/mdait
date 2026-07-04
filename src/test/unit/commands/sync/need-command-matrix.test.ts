import * as assert from "node:assert";
import { isTmCommitTarget } from "../../../../commands/tm/commit-filter";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

/**
 * need語彙 × コマンド経路のマトリクステスト。
 * 各needフラグに対する trans（needsTranslation）・tm.commit（isTmCommitTarget）・
 * マーカー往復（parse/toString）の期待動作を全組合せで固定する。
 * 新しいneed語彙を追加する際はこの表に行を追加すること。
 */
suite("need語彙×コマンドのマトリクス", () => {
	interface MatrixRow {
		need: string | null;
		/** trans が翻訳対象とするか */
		expectTranslatable: boolean;
		/** tm.commit が登録対象とするか（from設定済み前提） */
		expectTmCommit: boolean;
	}

	const matrix: MatrixRow[] = [
		{ need: null, expectTranslatable: false, expectTmCommit: true },
		{ need: "translate", expectTranslatable: true, expectTmCommit: false },
		{ need: "revise@old123", expectTranslatable: true, expectTmCommit: false },
		{ need: "review", expectTranslatable: false, expectTmCommit: false },
		{ need: "verify-deletion", expectTranslatable: false, expectTmCommit: true },
		{ need: "keep", expectTranslatable: false, expectTmCommit: false },
		{ need: "backfill", expectTranslatable: false, expectTmCommit: true },
	];

	// NOTE: need:backfill は原文側プレースホルダ（fromなし）に付くフラグであり、
	// from付きで現れることは通常ない。上の expectTmCommit:true は「from付きなら対象」という
	// フィルタ実装の事実を固定するもので、実運用ではfromなし＝noFromスキップになる。

	for (const row of matrix) {
		const label = row.need ?? "(なし)";

		test(`need:${label} → trans対象=${row.expectTranslatable}`, () => {
			const marker = new MdaitMarker("hash1", "from1", row.need);
			assert.strictEqual(marker.needsTranslation(), row.expectTranslatable);
		});

		test(`need:${label} → tm.commit対象=${row.expectTmCommit}`, () => {
			const marker = new MdaitMarker("hash1", "from1", row.need);
			const unit = new MdaitUnit(marker, "", 0, "content", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), row.expectTmCommit);
		});

		test(`need:${label} → マーカー文字列の往復（parse/toString）が同一`, () => {
			const marker = new MdaitMarker("hash1", "from1", row.need);
			const text = marker.toString();
			const parsed = MdaitMarker.parse(text);
			assert.ok(parsed);
			assert.strictEqual(parsed.hash, "hash1");
			assert.strictEqual(parsed.from, "from1");
			assert.strictEqual(parsed.need, row.need);
			assert.strictEqual(parsed.toString(), text);
		});
	}

	test("need:keep はfromなしマーカー形式（<!-- mdait hash need:keep -->）で往復できる", () => {
		const marker = new MdaitMarker("hash1", null, "keep");
		const text = marker.toString();
		assert.strictEqual(text, "<!-- mdait hash1 need:keep -->");
		const parsed = MdaitMarker.parse(text);
		assert.ok(parsed);
		assert.strictEqual(parsed.need, "keep");
		assert.strictEqual(parsed.from, null);
	});

	test("need:backfill はfromなしマーカー形式（<!-- mdait hash need:backfill -->）で往復できる", () => {
		const marker = new MdaitMarker("hash1", null, "backfill");
		const text = marker.toString();
		assert.strictEqual(text, "<!-- mdait hash1 need:backfill -->");
		const parsed = MdaitMarker.parse(text);
		assert.ok(parsed);
		assert.strictEqual(parsed.need, "backfill");
		assert.strictEqual(parsed.from, null);
	});
});
