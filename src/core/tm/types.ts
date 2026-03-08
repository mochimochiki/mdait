/**
 * 翻訳メモリ（TM）の型定義
 *
 * TMX 1.4準拠のデータモデルを定義する。
 * 文単位のTmEntryが管理単位で、sentenceHash（ソース文の正規化後CRC32）をキーとする。
 */

/**
 * 出典情報（将来用）
 *
 * 現在は未使用。将来、以下の機能が必要になった場合に使用予定:
 * - 複数出典の追跡（同じ文が複数ユニットで使用されている場合）
 * - 統計情報の収集（どのファイル・ユニットから多く登録されているか）
 */
export interface TmUsedIn {
	/** ワークスペースからの相対パス */
	unitPath: string;
	/** mdaitユニットハッシュ */
	unitHash: string;
}

/** TM 1エントリー（文単位） */
export interface TmEntry {
	/** CRC32(normalize(source_sentence)) — 8文字 */
	sentenceHash: string;
	/** 言語コード → テキスト (例: "en" → "...", "ja" → "...") */
	segments: Map<string, string>;
	/** 最初の出典（相対パス） */
	unitPath: string;
	/** ユニットの原文コンテンツハッシュ（MdaitMarker.hash） */
	sourceHash?: string;
}

/** TM検索結果 */
export interface TmMatch {
	/** 文ハッシュ */
	sentenceHash: string;
	/** ソース文 */
	source: string;
	/** ターゲット文（要求言語） */
	target: string;
	/** 最初の出典（表示用） */
	firstUsedIn: string;
}

/** LLM文アライメント結果 */
export interface SentencePair {
	/** ソース文 */
	source: string;
	/** ターゲット文 */
	target: string;
}
