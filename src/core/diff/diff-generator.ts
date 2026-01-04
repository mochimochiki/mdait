import { createPatch } from "diff";

/**
 * unified diff形式で差分を生成
 * @param oldContent 旧コンテンツ
 * @param newContent 新コンテンツ
 * @param fileName ファイル名（オプション、diff出力のヘッダに使用）
 * @returns unified diff文字列
 */
export function createUnifiedDiff(oldContent: string, newContent: string, fileName = "content"): string {
	return createPatch(fileName, oldContent, newContent, "", "", { context: 3 });
}

/**
 * diff出力からヘッダ行を除去した本体部分のみを取得
 * @param diff unified diff文字列
 * @returns ヘッダを除いたdiff本体
 */
export function stripDiffHeader(diff: string): string {
	const lines = diff.split("\n");
	// 最初の4行はヘッダ（---、+++、@@で始まる前まで）
	const headerEnd = lines.findIndex((line) => line.startsWith("@@"));
	if (headerEnd === -1) {
		return diff;
	}
	return lines.slice(headerEnd).join("\n");
}

/**
 * 差分があるかどうかを判定
 * @param oldContent 旧コンテンツ
 * @param newContent 新コンテンツ
 * @returns true: 差分あり、false: 差分なし
 */
export function hasDiff(oldContent: string, newContent: string): boolean {
	return oldContent !== newContent;
}
