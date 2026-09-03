/**
 * @file plain-review-pair.test.ts
 * @description 非Markdown（ファイル＝1ユニット）のレビュー対象ペアの組み立て。
 *
 * 背景: 非Markdownは翻訳されるのにレビューだけ素通りしていた。取り込みのあと
 * **確認待ちが人手でしか外れない**（実測: 見本サイトの取り込みで .txt / .csv / .json の
 * 3本が確認待ちのまま残った）。状態は `unit-state` の行にしか無いので、そこから
 * Markdown と同じ形のペアを組み立てて、あとの流れに載せる。
 */

import { strict as assert } from "node:assert";
import { buildPlainReviewPair } from "../../../../commands/ai-review/plain-review-pair";

const SOURCE = "お知らせ\n\n明日は休みです。\n";
const TARGET = "Notice\n\nWe are closed tomorrow.\n";

suite("非Markdownのレビュー対象ペア", () => {
	test("確認待ちの行から、ファイル1本ぶんのペアが1件できること", () => {
		const pair = buildPlainReviewPair(
			{ hash: "tgt1", from: "src1", need: "review" },
			SOURCE,
			TARGET,
			"notice.txt",
		);
		assert.ok(pair, "確認待ちなのに対象になっていない");
		assert.equal(pair.kind, "unit");
		assert.equal(pair.targetUnit.title, "notice.txt", "レポートで指す名前がファイル名になっていない");
		assert.equal(pair.targetUnit.content, TARGET, "訳文がまるごと1ユニットになっていない");
		assert.equal(pair.sourceUnit?.content, SOURCE, "原文が from で引けていない");
		assert.equal(pair.targetUnit.marker?.need, "review");
		assert.equal(pair.targetUnit.marker?.from, "src1");
	});

	test("行が無ければ対象にならないこと", () => {
		assert.equal(buildPlainReviewPair(undefined, SOURCE, TARGET, "notice.txt"), undefined);
	});

	test("from が無ければ対象にならないこと（比べる相手が決まらない）", () => {
		const pair = buildPlainReviewPair({ hash: "tgt1", from: "", need: "review" }, SOURCE, TARGET, "notice.txt");
		assert.equal(pair, undefined);
	});

	test("確認待ちでなければ既定（pending）では対象にならないこと", () => {
		assert.equal(
			buildPlainReviewPair({ hash: "tgt1", from: "src1", need: "" }, SOURCE, TARGET, "notice.txt"),
			undefined,
		);
		assert.equal(
			buildPlainReviewPair({ hash: "tgt1", from: "src1", need: "translate" }, SOURCE, TARGET, "notice.txt"),
			undefined,
		);
	});

	test("監査（audit）では確定済みの行も対象になること", () => {
		const pair = buildPlainReviewPair({ hash: "tgt1", from: "src1", need: "" }, SOURCE, TARGET, "notice.txt", "audit");
		assert.ok(pair, "確定済みの行が監査の対象になっていない");
		assert.equal(pair.targetUnit.marker?.need, null);
	});

	test("翻訳待ち・改訂待ちは監査でも対象にしないこと（確定した対訳ではない）", () => {
		for (const need of ["translate", "revise@src0", "isolate", "verify-deletion"]) {
			assert.equal(
				buildPlainReviewPair({ hash: "tgt1", from: "src1", need }, SOURCE, TARGET, "notice.txt", "audit"),
				undefined,
				`${need} が監査の対象になっている`,
			);
		}
	});
});
