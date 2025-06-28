/**
 * インデックスファイルの型定義とユーティリティ
 */

export interface UnitIndexEntry {
	/** ファイルタイプ（md, csv等） */
	type: string;
	/** 言語 */
	lang: string;
	/** インデックスファイルからの相対パス */
	path: string;
	/** ファイル内でのユニットインデックス */
	unitIndex: number;
	/** from属性のハッシュ値（翻訳元がある場合） */
	from: string | null;
	/** ユニットのタイトル（見出しなど） */
	title: string;
	/** 開始行番号（0-based） */
	startLine: number;
	/** 終了行番号（0-based） */
	endLine: number;
	/** needフラグ（translate, review等） */
	needFlag: string | null;
}

/**
 * インデックスファイルの形式
 * hash主キー型で、1つのhashに複数のユニット出現箇所が対応
 */
export interface UnitIndex {
	[hash: string]: UnitIndexEntry[];
}

/**
 * インデックスファイルのメタデータ
 */
export interface IndexMetadata {
	/** インデックスファイルのバージョン */
	version: string;
}

/**
 * インデックスファイル全体の構造
 */
export interface IndexFile {
	metadata: IndexMetadata;
	units: UnitIndex;
}
