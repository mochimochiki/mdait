/**
 * 翻訳メモリ（TM）の型定義
 *
 * TMX 1.4準拠のデータモデルを定義する。
 * 文単位のTmEntryが管理単位で、sentenceHash（ソース文の正規化後CRC32）をキーとする。
 */

/** 出典情報 */
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
	/** 出典ユニット一覧 */
	usedIn: TmUsedIn[];
	/** 初回登録日時（ISO 8601） */
	createdAt: string;
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

/** TMXファイル全体のデータ構造 */
export interface TmxData {
	/** TMXバージョン */
	version: string;
	/** ヘッダー情報 */
	header: TmxHeader;
	/** エントリーMap: sentenceHash → TmEntry */
	entries: Map<string, TmEntry>;
}

/** TMXヘッダー */
export interface TmxHeader {
	creationtool: string;
	creationtoolversion: string;
	datatype: string;
	segtype: string;
	/** TMX原形式 */
	"o-tmf": string;
	/** ソース言語 ("*all*" = 各TUで異なる) */
	srclang: string;
}
