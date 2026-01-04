import * as zlib from "node:zlib";

/**
 * コンテンツをgzip圧縮してbase64エンコード
 * @param content 圧縮対象のテキスト
 * @returns base64エンコードされた圧縮データ
 */
export function encodeSnapshot(content: string): string {
	const buffer = Buffer.from(content, "utf-8");
	const compressed = zlib.gzipSync(buffer);
	return compressed.toString("base64");
}

/**
 * base64デコードしてgzip解凍
 * @param encoded base64エンコードされた圧縮データ
 * @returns 復元されたテキスト
 */
export function decodeSnapshot(encoded: string): string {
	const compressed = Buffer.from(encoded, "base64");
	const decompressed = zlib.gunzipSync(compressed);
	return decompressed.toString("utf-8");
}
