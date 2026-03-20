/** TM variant の provenance */
export interface TmVariant {
	/** 言語別テキスト */
	text: string;
	/** ワークスペース相対パス */
	unitPath?: string;
	/** mdaitユニットハッシュ */
	unitHash?: string;
}

/** TM 1エントリー（1 TU = 1 primary sentence） */
export interface TmEntry {
	/** CRC32(normalize(primary_sentence)) — 8文字 */
	tuid: string;
	/** 正準 primary sentence */
	primary: string;
	/** 言語コード → variant */
	variants: Map<string, TmVariant>;
}

/** 旧TM入力形式との互換用 */
export interface LegacyTmEntry {
	sentenceHash: string;
	segments: Map<string, string>;
	unitPath: string;
}

/** tm-commit に渡す既存 TM 情報 */
export interface ExistingTmEntriesItem {
	tuid: string;
	primarySentence: string;
	localSentence: string | null;
}

/** LLM が返す TM登録計画 */
export interface TmCommitEntry {
	type: "new" | "update";
	tuid: string;
	primary: string;
	local: string;
}

/** sync時のTMクリーンアップで参照される処理対象ユニット */
export interface CurrentPrimaryUnit {
	unitPath: string;
	unitHash: string;
	content: string;
}

/** TM検索結果 */
export interface TmMatch {
	/** TU識別子（互換のため sentenceHash 名を維持） */
	sentenceHash: string;
	/** ソース文 */
	source: string;
	/** ターゲット文（要求言語） */
	target: string;
	/** 最初の出典（表示用） */
	firstUsedIn: string;
}
