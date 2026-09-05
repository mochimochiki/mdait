/** TM variant の provenance */
export interface TmVariant {
	/** 言語別テキスト */
	text: string;
}

/** TM 1エントリー（1 TU = 1 primary sentence） */
export interface TmEntry {
	/** CRC32(normalize(primary_sentence)) — 8文字 */
	tuid: string;
	/** 正準 primary sentence */
	primary: string;
	/** 参照有用性の重み（0.0-1.0） */
	weight: number;
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
	/**
	 * いま訳している文にどれだけ近いか（0〜1）。
	 *
	 * trigram の Jaccard 係数で、**選び方のスコアとは別物**である。選び方のスコアは
	 * 似すぎた候補を外すための調整（MMR）が入っていて負にもなるので、「どれだけ近いか」
	 * としては読めない。
	 *
	 * これを持たせるのは、参考を受け取る側が**完全一致と遠い参考を区別できる**ようにするため。
	 * 実測では、区別が無いまま渡すと近似一致の採用が回ごとに揺れた。
	 * ハッシュの一致で引いたものは正規化した本文が同じなので 1 になる。
	 */
	similarity: number;
}
