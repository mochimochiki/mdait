// 原文だけが巻き戻された疑いの判定（isOneSidedRollback）のテスト。
//
// 原文と訳文を結んでいるのは「原文のマーカーの hash」と「訳文の from」の一致だけで、
// この2つは sync のたびに同時に書き換わる。そろって戻す限り紐は切れない。
// 切れるのは片側だけを戻したときで、そのとき訳文は「原文を失った」として物理削除される。
//
// ここでやるのは対応付けの推測ではなく、「ずれている疑い」を言うことだけ。
// **正当な操作で立たないこと**が命なので、正常系を厚く固定する。

import * as assert from "node:assert";
import { isOneSidedRollback } from "../../../../core/matching/one-sided-rollback";

/** 訳文の結び先 */
function link(from: string, reviseSnapshot: string | null = null) {
	return { from, reviseSnapshot };
}

suite("原文だけが巻き戻された疑い", () => {
	test("宙に浮いた訳文が revise@ を持ち、原文に未参照のマーカーがあれば疑う", () => {
		// 原文: 章1(s1) / 章B(s2b ← 巻き戻って現れた) / 章3(s3)
		// 訳文: 章1(from:s1) / 章Bの訳(from:s2c ← もう原文に無い, revise@s2a) / 章3(from:s3)
		assert.strictEqual(
			isOneSidedRollback({
				persistedSourceHashes: ["s1", "s2b", "s3"],
				targetLinks: [link("s1"), link("s2c", "s2a"), link("s3")],
			}),
			true,
		);
	});

	test("章を削除しただけなら疑わない（増えた章が無い）", () => {
		assert.strictEqual(
			isOneSidedRollback({
				persistedSourceHashes: ["s1", "s3"],
				targetLinks: [link("s1"), link("s2", "s2old"), link("s3")],
			}),
			false,
			"原文側に未参照のマーカーが無いので、通常の削除として扱う",
		);
	});

	test("章を消して新しい章を手で書いたなら疑わない（手書きの章にマーカーは無い）", () => {
		// 章C は手で書いたのでマーカーを持たない ＝ persistedSourceHashes に現れない
		assert.strictEqual(
			isOneSidedRollback({
				persistedSourceHashes: ["s1", "s3"],
				targetLinks: [link("s1"), link("s2"), link("s3")],
			}),
			false,
		);
	});

	test("他ファイルからマーカー付きの章を移してきただけなら疑わない", () => {
		// 原文に未参照のマーカー（moved）はあるが、消えた章の訳は訳し終わっていて revise@ が無い
		assert.strictEqual(
			isOneSidedRollback({
				persistedSourceHashes: ["s1", "moved", "s3"],
				targetLinks: [link("s1"), link("s2"), link("s3")],
			}),
			false,
			"revise@ を持たない訳文は、原文を戻したときに取り残される状態ではない",
		);
	});

	test("ふつうの改訂待ち（原文は編集されただけ）は疑わない", () => {
		// 編集しても原文のマーカーは前の版のまま＝訳文の from から指されている
		assert.strictEqual(
			isOneSidedRollback({
				persistedSourceHashes: ["s1", "s2", "s3"],
				targetLinks: [link("s1"), link("s2", "s2old"), link("s3")],
			}),
			false,
		);
	});

	test("章を並べ替えただけなら疑わない", () => {
		assert.strictEqual(
			isOneSidedRollback({
				persistedSourceHashes: ["s3", "s1", "s2"],
				targetLinks: [link("s1"), link("s2"), link("s3")],
			}),
			false,
		);
	});

	test("マーカーを持たない原文だけの文書（初回同期の直前）では疑わない", () => {
		assert.strictEqual(isOneSidedRollback({ persistedSourceHashes: [], targetLinks: [] }), false);
	});

	test("2つの条件は両方必要（片方だけでは疑わない）", () => {
		// 未参照のマーカーだけ
		assert.strictEqual(
			isOneSidedRollback({ persistedSourceHashes: ["s1", "orphanMark"], targetLinks: [link("s1")] }),
			false,
		);
		// 宙に浮いた revise@ 付きの訳文だけ
		assert.strictEqual(
			isOneSidedRollback({ persistedSourceHashes: ["s1"], targetLinks: [link("s1"), link("gone", "old")] }),
			false,
		);
	});
});
