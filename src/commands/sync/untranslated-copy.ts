/**
 * まだ訳していない訳文（原文の丸写し）が、古い原文のまま取り残されているかを判定する。
 * Markdown のユニット（`sync-command.ts` の `refreshUntranslatedCopy`）と
 * 非 Markdown のファイル（`plain-file-handler.ts` の `sync`）で同じ規則を使う。
 */

import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";

/**
 * 訳文が「古い原文の丸写し」で、いまの原文へ写し直してよいかを答える。
 *
 * 写し直してよい根拠は**その訳文に人の仕事が入っていないこと**だけであり、それは
 * ハッシュで確かめられる。`from` は「この訳文が写した原文の中身」のハッシュなので、
 * いまの訳文の中身のハッシュが `from` と一致するなら、訳文は一字一句その原文のままである。
 * 一致しなければ誰かが書いている（手訳の途中・既訳の取り込み）ので触らない。
 *
 * `need:translate` に限る。`revise` は訳し終えた本文を守る話で、`review` は人の確認待ち、
 * `isolate` は追随しないという宣言であり、どれも写し直してよい状態ではない。
 *
 * @param need 訳文のいまの need
 * @param from 訳文のいまの `from`（sync で進める前の値）
 * @param targetHash 訳文の中身のハッシュ
 * @param sourceHash いまの原文のハッシュ
 * @param targetContent 訳文の中身（スナップショットとの突き合わせに使う）
 */
export async function isStaleUntranslatedCopy(
	need: string | null | undefined,
	from: string | null | undefined,
	targetHash: string,
	sourceHash: string,
	targetContent: string,
): Promise<boolean> {
	if (need !== "translate") {
		return false;
	}
	if (!from || targetHash === sourceHash) {
		return false; // 訳文はもう今の原文の丸写しである。することは無い
	}
	if (targetHash === from) {
		// 直前の原文の丸写しである（いちばん多い形。ディスクを読まずに決まる）
		return true;
	}
	// `from` が既に先へ進んでしまった訳文の救済。以前の sync は、原文が変わっても
	// 丸写しを写し直さないまま `from` だけ進めていたため、「一度も触っていないのに
	// hash≠from」という訳文が既に手元にある（`from` は今の原文を指しているので、
	// 上の安い判定では拾えない）。その形は手編集と見分けが付かないので、
	// **過去の原文そのものだったか**をスナップショット（`unit-registry`）に問い合わせる。
	// 中身まで突き合わせるので、ハッシュがたまたま衝突しても人の書いた訳文を捨てない
	const snapshot = await UnitRegistryManager.getInstance().loadUnitRegistry(targetHash);
	return snapshot !== null && snapshot === targetContent;
}

/**
 * 翻訳待ち（`need:translate`）の訳文に、**印を付けたあとで**人の文章が書き込まれたかを答える。
 *
 * 真なら呼び出し側は `need:review` に切り替える（ADR-260923-07）。`need:translate` は「次の✨翻訳が本文を
 * 上書きしてよい」の意味なので、放っておくと人の書いた文章が機械翻訳で消える。起きる経路は2つある。
 *
 * - 未訳の章（原文の丸写し）を人が手で訳し始めて保存した
 * - 訳し終えた章を消して保存し（sync が原文の丸写しで作り直す）、あとで元の訳を貼り戻した。
 *   手元の控え（held）があれば元の状態へ戻るが、控えは共有しないので別の環境では無い
 *
 * 判定の決め手は「**記録した本文の hash といまの本文の hash が違う**」ことである。印を付けた
 * 時点の本文は記録と一致するので、「この既訳は採用しない」（`requestTranslate`。review の本文を
 * 残したまま translate に付け替える）の答えを次の sync が覆すことは無い。
 *
 * 次のものは人の文章ではないので外す。
 * - 本文が空
 * - いまの原文の丸写し、または記録した原文（`from`）の丸写し
 * - 古い原文の丸写し（`isStaleUntranslatedCopy` が真。写し直しを見送った回も含む）
 *
 * @param need 訳文のいまの need
 * @param recordedHash 記録してある訳文の hash（sync で進める前の値）
 * @param from 訳文のいまの `from`（sync で進める前の値）
 * @param targetHash 訳文の中身のハッシュ
 * @param targetContent 訳文の中身
 * @param sourceContent いまの原文の中身
 * @param staleCopy 古い原文の丸写しと判定済みか（`isStaleUntranslatedCopy` の答え）
 */
export function isWrittenOverTranslateMark(
	need: string | null | undefined,
	recordedHash: string | null | undefined,
	from: string | null | undefined,
	targetHash: string,
	targetContent: string,
	sourceContent: string,
	staleCopy: boolean,
): boolean {
	if (need !== "translate" || staleCopy) {
		return false;
	}
	if (targetContent.trim() === "" || targetContent === sourceContent) {
		return false;
	}
	return recordedHash !== targetHash && from !== targetHash;
}
