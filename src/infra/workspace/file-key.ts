import * as path from "node:path";

/**
 * ファイルパスを同一性比較用のキーに正規化する。
 *
 * `path.resolve` で絶対パス化・冗長セグメント除去を行ったうえで、
 * ファイルシステムが大文字小文字を区別しない win32 ではドライブレターや
 * パス表記の大小差で同一ファイルが別キー扱いにならないよう小文字化する。
 * FileMutex のロックキーやダーティドキュメント検出のパス比較に使用する。
 *
 * @param filePath 正規化するファイルパス
 * @param platform 対象プラットフォーム（テスト用に注入可能。既定は実行環境）
 */
export function normalizeFileKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
	const resolved = path.resolve(filePath);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}
