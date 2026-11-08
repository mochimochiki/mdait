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
	 * @deprecated 用語集のマージ処理ではisSameEntryを使用してください
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
	 * 2つのエントリが同一エントリかを判定
	 * contextが一致し、かつ共通の言語で用語が一致する場合に同一とみなす
	 *
	 * @param entry1 エントリ1
	 * @param entry2 エントリ2
	 * @param primaryLang 優先的にチェックする言語（オプション）
	 * @returns 同一エントリの場合true
	 *
	 * **重複判定ロジック:**
	 * 1. primaryLangが両方に存在し、かつ異なる場合は別エントリ（明示的に異なる用語と判断）
	 *    同じ場合も、context が違い、他の言語で訳語が食い違うなら別エントリ（訳し分け）
	 * 2. それ以外で共通言語に同じ用語がある場合は同一エントリ（重複）
	 * 3. 共通言語がない場合はcontextのみで同一判定
	 */
	export function isSameEntry(entry1: TermEntry, entry2: TermEntry, primaryLang?: string): boolean {
		// primaryLangが指定されていて、両方に存在する場合
		if (primaryLang) {
			const term1 = getTerm(entry1, primaryLang);
			const term2 = getTerm(entry2, primaryLang);
			if (term1 && term2) {
				// primaryLangが両方とも埋まっていて異なる場合は別エントリとみなす
				if (term1.trim() !== term2.trim()) {
					return false;
				}
				// 同じ語でも、context が違い、どこかの言語で訳語が食い違うなら**別の意味**
				// （同じ語の訳し分け。ADR-261108-06）。訳語を上書きして1行に畳むと、
				// 使い分けの片方が消える
				return (
					entry1.context.trim() === entry2.context.trim() || !hasConflictingTranslation(entry1, entry2, primaryLang)
				);
			}
		}

		// 共通の言語が1つ以上あり、その用語が一致するか確認
		const langs1 = getLanguages(entry1);
		const langs2 = getLanguages(entry2);

		for (const lang of langs1) {
			if (langs2.includes(lang)) {
				const term1 = getTerm(entry1, lang);
				const term2 = getTerm(entry2, lang);
				if (term1 && term2 && term1.trim() === term2.trim()) {
					return true;
				}
			}
		}

		// 共通の言語がない場合、contextのみで判定（同じcontextなら同一と仮定）
		// これはcontextが十分にユニークであることを前提とする
		// contextが異なる場合は別エントリ
		const ctx1 = entry1.context.trim();
		const ctx2 = entry2.context.trim();
		if (ctx1 !== ctx2) {
			return false;
		}
		return true;
	}

	/**
	 * 基準言語以外のどこかの言語で、両方が訳語を持ち、それが違うか。
	 * 片方が空の言語は食い違いに数えない（空欄を埋める合流は同じ意味の更新）。
	 */
	function hasConflictingTranslation(entry1: TermEntry, entry2: TermEntry, primaryLang: string): boolean {
		for (const lang of getLanguages(entry1)) {
			if (lang === primaryLang) continue;
			const term1 = getTerm(entry1, lang)?.trim();
			const term2 = getTerm(entry2, lang)?.trim();
			if (term1 && term2 && term1 !== term2) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 候補と同じエントリ（同じ意味の行）を既存の中から探す。見つからなければ -1。
	 *
	 * 同じ語に意味の違う行が複数あるときは、**context が一致する行を先に選ぶ**。
	 * 先頭から `isSameEntry` で探すだけだと、訳語の空欄を埋める候補（展開の結果など）が
	 * 1つ目の意味に吸い込まれ、2つ目の意味の行が埋まらない。
	 */
	export function findSameEntryIndex(
		entries: readonly TermEntry[],
		candidate: TermEntry,
		primaryLang?: string,
	): number {
		const candidatePrimary = primaryLang ? getTerm(candidate, primaryLang)?.trim() : undefined;
		if (primaryLang && candidatePrimary) {
			const exact = entries.findIndex(
				(existing) =>
					getTerm(existing, primaryLang)?.trim() === candidatePrimary &&
					existing.context.trim() === candidate.context.trim(),
			);
			if (exact >= 0) {
				return exact;
			}
		}
		return entries.findIndex((existing) => isSameEntry(existing, candidate, primaryLang));
	}

	/**
	 * エントリをマージ
	 */
	export function merge(entry1: TermEntry, entry2: TermEntry): TermEntry {
		return create(entry1.context || entry2.context, {
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
