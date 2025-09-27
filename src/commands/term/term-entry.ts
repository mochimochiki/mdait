/**
 * @file term-entry.ts
 * @description 用語エントリのデータ構造定義
 */

/**
 * 用語エントリ
 */
export interface TermEntry {
	/** コンテキスト情報（用語の説明、使用場面など） */
	readonly context: string;
	/** 言語コード -> その言語の用語情報 */
	readonly languages: Readonly<Record<string, LangTerm>>;
}

/**
 * 特定言語の用語情報
 */
export interface LangTerm {
	/** 正規化された用語 */
	readonly term: string;
	/** 表記揺れ・誤記のリスト */
	readonly variants: readonly string[];
}

/**
 * TermEntryのユーティリティ関数群
 */
export namespace TermEntry {
	/**
	 * 新しいTermEntryを作成
	 */
	export function create(context: string, languages: Record<string, LangTerm>): TermEntry {
		return {
			context: context.trim(),
			languages: Object.freeze({ ...languages }),
		};
	}

	/**
	 * エントリが持つ言語のリストを取得
	 */
	export function getLanguages(entry: TermEntry): string[] {
		return Object.keys(entry.languages).sort();
	}

	/**
	 * 指定言語の用語を取得
	 */
	export function getTerm(entry: TermEntry, language: string): string | undefined {
		return entry.languages[language]?.term;
	}

	/**
	 * 指定言語の表記揺れリストを取得
	 */
	export function getvariants(entry: TermEntry, language: string): readonly string[] {
		return entry.languages[language]?.variants ?? [];
	}

	/**
	 * 指定言語の情報を持っているかチェック
	 */
	export function hasLanguage(entry: TermEntry, language: string): boolean {
		return language in entry.languages;
	}

	/**
	 * エントリが空（言語情報がない）かチェック
	 */
	export function isEmpty(entry: TermEntry): boolean {
		return Object.keys(entry.languages).length === 0;
	}

	/**
	 * 基準言語での重複検知
	 * primaryLangの用語が一致する場合に重複とみなす
	 */
	export function isDuplicate(entry1: TermEntry, entry2: TermEntry, primaryLang: string): boolean {
		// 基準言語の用語を比較
		const term1 = getTerm(entry1, primaryLang);
		const term2 = getTerm(entry2, primaryLang);

		// どちらかに基準言語の用語がない場合は重複ではない
		if (!term1 || !term2) {
			return false;
		}

		// 基準言語の用語が完全一致する場合に重複
		return term1.trim() === term2.trim();
	}

	/**
	 * エントリをマージ（entry2の内容でentry1を上書き）
	 */
	export function merge(entry1: TermEntry, entry2: TermEntry): TermEntry {
		return create(entry2.context || entry1.context, {
			...entry1.languages,
			...entry2.languages,
		});
	}
}

/**
 * LanguageTermInfoのユーティリティ関数群
 */
export namespace LangTerm {
	/**
	 * 新しいLanguageTermInfoを作成
	 */
	export function create(term: string, variants: readonly string[] = []): LangTerm {
		return {
			term: term.trim(),
			variants: [...variants].map((s) => s.trim()).filter(Boolean),
		};
	}
}
