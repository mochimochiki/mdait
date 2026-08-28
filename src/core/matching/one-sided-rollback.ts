/**
 * @file one-sided-rollback.ts
 *   原文と訳文が**別々に**巻き戻された疑いを見つけるための判定。
 *
 *   原文と訳文を結んでいるのは「原文のマーカーの hash」と「訳文の from」が同じ値かどうか、
 *   それだけである。この2つは sync のたびに同時に書き換わるので、sync 後の状態は必ず
 *   自己整合している。**そろってコミットし、そろって戻す限り、紐は切れない。**
 *
 *   切れるのは片側だけを戻したときである（`git checkout -- 原文.md` など）。
 *   原文の本文とマーカーが一緒に前の版へ戻り、訳文はいまの版を指したまま取り残される。
 *   すると訳文は「原文を失った」と見なされ、既定設定（`sync.autoDelete: true`）では
 *   **物理削除**される。原文は目の前にあるのに、である（実測）。
 *
 *   ここでやるのは**対応付けの推測ではない**。「ずれている疑いがある」ことだけを言い、
 *   削除を見送って人の確認に委ねる。推測して繋ぎ直す案は実際に試して、本文が同じ章が
 *   2つある文書で「生きている章の訳を追い出す」という別の事故を作った（ADR-260825-04）。
 *   倒す方向を保守側（消さない）に限れば、その種の誤対応は原理的に起きない。
 *
 * @module core/matching/one-sided-rollback
 */

/** 判定に使う、原文と訳文の「読み込んだままの姿」 */
export interface OneSidedRollbackInput {
	/**
	 * 原文の本文に**書かれていた**マーカーの hash。
	 * 合成した hash を混ぜてはいけない — マーカーは sync しか書かないという事実こそが
	 * 「過去に同期された姿のまま現れた」ことの証拠になる。
	 */
	readonly persistedSourceHashes: readonly string[];
	/** 訳文が持つ結び先。`from` を持つユニットだけを並べる */
	readonly targetLinks: readonly { readonly from: string; readonly reviseSnapshot: string | null }[];
}

/**
 * 原文だけが巻き戻された疑いがあるか。
 *
 * 次の2つが**同時に**成り立つときだけ true を返す。
 *
 * 1. **宙に浮いた訳文が `revise@` を持っている** — 訳したあと原文が変わり、まだ追いついて
 *    いない章。原文を戻したときに取り残されるのは必ずこの状態のものだけである
 *    （追いついていれば `from` が訳した版を指しているので、戻しても一致する）
 * 2. **原文に「マーカーを持つのに、どの訳文の `from` からも指されていない」章がある** —
 *    マーカーは sync しか書かないので、これは「過去に同期された姿のまま、訳文と
 *    切り離されて現れた」という意味になる
 *
 * 正当な操作ではどちらも立たない（実測）。
 *
 * | 操作 | 1. 宙に浮いた訳文の revise@ | 2. 未参照の原文マーカー |
 * |---|---|---|
 * | 章を削除するだけ | — | 無し（増えた章が無い） |
 * | 章を消して新しい章を書く | 無し（訳し終わっている） | 無し（手書きの章にマーカーは無い） |
 * | 章を並べ替える | — | 無し（全部 from から指される） |
 * | 章の本文を編集する | — | 無し（マーカーは前の版のまま指されている） |
 * | 他ファイルから章を移す | 無し（訳し終わっている） | 有り |
 * | **原文だけ巻き戻す** | **有り** | **有り** |
 *
 * 2つを併せて要求するのは、片方だけでは足りないからである。1 だけなら普通の改訂待ちが
 * 引っかかり、2 だけなら他ファイルからの章の移動が引っかかる。
 */
export function isOneSidedRollback(input: OneSidedRollbackInput): boolean {
	const sourceHashes = new Set(input.persistedSourceHashes);
	const referenced = new Set<string>();
	let strandedWithSnapshot = false;
	for (const link of input.targetLinks) {
		referenced.add(link.from);
		if (!sourceHashes.has(link.from) && link.reviseSnapshot) {
			strandedWithSnapshot = true;
		}
	}
	if (!strandedWithSnapshot) {
		return false;
	}
	for (const hash of sourceHashes) {
		if (!referenced.has(hash)) {
			return true;
		}
	}
	return false;
}
