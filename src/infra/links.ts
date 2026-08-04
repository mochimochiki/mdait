/**
 * @file links.ts
 * @description ユーザーへ案内する外部ドキュメントの URL を1か所にまとめる。
 *   各所で URL 文字列を書き写していたため、参照先が消えても気づけなかった
 *   （`docs/guide/ja/troubleshooting.md` は存在しないのに4ファイルが指していた）。
 * @module infra/links
 */

/**
 * 「困ったとき」への共通リンク（利用者ガイドの該当節）。
 * 追加するときは実在する見出しであることを確かめること。
 */
export const TROUBLESHOOTING_URL =
	"https://github.com/mochimochiki/mdait/blob/main/docs/guide-user.md#%E5%9B%B0%E3%81%A3%E3%81%9F%E3%81%A8%E3%81%8D";
