/**
 * @file shrink-guard.ts
 *   「数が急に減った」ことを、編集の結果ではなく**一時的な崩れ**かもしれないと疑うための判定。
 *
 *   ユニットの数は簡単に激減する。コードブロックの閉じ忘れで以降が全部コードとして飲まれる、
 *   `sync.level` の設定を変えて見出しの粒度が変わる、といったことが普通に起きる。
 *   その状態で「無くなったもの」を消してしまうと、原因を直しても戻らない。
 *
 *   同じ疑いを2箇所で使う。
 *   - `unit-state` の末尾行を刈るか（`marker-provider.ts` の `shouldPruneTail`）
 *   - 原文を失った訳文ユニットを自動削除するか（`sync-command.ts` の `resolveOrphanPolicy`）
 *
 *   **述語は1つ。ただし慎重さの度合いは用途で変える。** 同じ現象を見ていても、判断を
 *   誤ったときの損失が違うからである。
 *
 *   | 用途 | 疑いそこねたときに起きること | 取り返し |
 *   |---|---|---|
 *   | 刈り取り | 行が1本余分に残る | **つく**（次の刈り取りで消えるし、内容が一致すれば復帰する） |
 *   | 自動削除 | **訳文が物理削除される** | **つかない**（git からしか戻らない） |
 *
 *   だから削除側は「潰れた形」をより広く拾う。閾値の場当たりな調整ではなく、
 *   代償の非対称にもとづく区別である。
 *
 * @module core/matching/shrink-guard
 */

/** 疑い方の設定。用途ごとに1つ持つ */
export interface ShrinkSuspicionPolicy {
	/** 「一時的に減っただけかもしれない」と疑い始める減少幅（件）。比率の条件と併せて使う */
	readonly minDrop: number;
	/**
	 * これ以下しか残らなかったら、減少幅や比率に関わらず「潰れた」とみなす。
	 *
	 * パースが崩れると、文書は**大きさに関係なく1ユニットまで潰れる**（以降が全部コードとして
	 * 飲まれるため）。つまり崩れの見分けどころは「残りがほとんど無い」であって「たくさん減った」
	 * ではない。比率と減少幅だけで判断すると、見出し2つの README のような小さい文書が素通りする
	 * （実測: 3ユニットの訳文が、フェンスの閉じ忘れ1つで2件とも物理削除された）。
	 */
	readonly collapsedRemainder: number;
}

/**
 * `unit-state` の末尾行を刈るかどうかの設定。
 *
 * 行が2件から1件に減るのは普通の編集で、いちいち疑って保留席へ送ると邪魔になる。
 * 疑いそこねても行が1本余るだけで取り返しがつくので、比率と減少幅だけで判断する。
 *
 * `collapsedRemainder: 0` にこの経路が到達することは無い。呼び出し元の `shouldPruneTail` が
 * 「ユニット0件なら刈らない」を先に返すためで、意味としての既定値としてここに書いてある。
 */
export const PRUNE_SUSPICION: ShrinkSuspicionPolicy = { minDrop: 3, collapsedRemainder: 0 };

/**
 * 原文を失った訳文ユニットを自動削除するかどうかの設定。
 *
 * **対応が1件以下しか残らなかったら、減少幅が1件でも疑う。** 崩れは文書の大きさに関係なく
 * 1ユニットまで潰すので、これが崩れの形そのものだからである。守られるかどうかが元の
 * ユニット数だけで決まっていた（4ユニット以上なら守られ、3ユニット以下は消える）状態を正す。
 *
 * 加えて、半分未満へまとめて減ったときも疑う（章をごっそり落とす改稿）。
 */
export const DELETE_SUSPICION: ShrinkSuspicionPolicy = { minDrop: 3, collapsedRemainder: 1 };

/**
 * 減り方が「一時的な崩れ」を疑うほど大きいか。
 *
 * @param before 崩れる前にあった数
 * @param after いま残っている数（0 も含む。全部消えるのは最も疑わしい）
 * @param policy 用途ごとの慎重さ（既定は刈り取り側）
 */
export function isSuspiciousShrink(
	before: number,
	after: number,
	policy: ShrinkSuspicionPolicy = PRUNE_SUSPICION,
): boolean {
	const dropped = before - after;
	if (dropped <= 0) {
		return false;
	}
	if (after <= policy.collapsedRemainder) {
		return true;
	}
	// 比率だけで見ると 2 件が 1 件になっただけで疑ってしまうので、絶対件数の下限を併せる
	return dropped >= policy.minDrop && after * 2 < before;
}
