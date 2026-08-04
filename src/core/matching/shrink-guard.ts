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
 *   - 原文を失った訳文ユニットを自動削除するか（`sync-command.ts`）
 *
 *   判定は1つでなければならない。行だけを守って本文を消したら意味が無いためである。
 *
 * @module core/matching/shrink-guard
 */

/**
 * 「一時的に減っただけかもしれない」と疑い始める減少幅（件）。
 * これ未満の減少は、いくつか消したという普通の編集として扱う。
 */
export const MIN_SUSPICIOUS_DROP = 3;

/**
 * 減り方が「一時的な崩れ」を疑うほど大きいか。
 *
 * 半分未満へ減り、かつ減少幅が `MIN_SUSPICIOUS_DROP` 以上のときに真。
 * 比率だけで見ると 2 件が 1 件になっただけで疑ってしまうので、絶対件数の下限を併せる。
 *
 * @param before 崩れる前にあった数
 * @param after いま残っている数（0 も含む。全部消えるのは最も疑わしい）
 */
export function isSuspiciousShrink(before: number, after: number): boolean {
	return before - after >= MIN_SUSPICIOUS_DROP && after * 2 < before;
}
