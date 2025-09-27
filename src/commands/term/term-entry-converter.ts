/**
 * @file term-entry-converter.ts
 * @description CSV形式とTermEntry構造化データの相互変換ユーティリティ
 */

import { LangTerm, TermEntry } from "./term-entry";

/**
 * CSV⇔TermEntry変換ユーティリティ
 */
export namespace TermEntryConverter {
	/**
	 * CSVの行データからTermEntryを作成
	 *
	 * @param row CSV行データ（ヘッダーをキーとするオブジェクト）
	 * @param allLanguages 対象言語のリスト
	 */
	export function fromCsvRow(row: Record<string, string>, allLanguages: readonly string[]): TermEntry {
		const languages: Record<string, LangTerm> = {};

		for (const lang of allLanguages) {
			const term = row[lang]?.trim();
			if (!term) continue;

			const variantsKey = `variants_${lang}`;
			const variantsText = row[variantsKey]?.trim() || "";

			// CSV形式の表記揺れをパース（カンマ区切り、二重引用符で囲まれている場合がある）
			const variants = parsevariantsFromCsv(variantsText);

			languages[lang] = LangTerm.create(term, variants);
		}

		const context = row.context?.trim() || "";

		return TermEntry.create(context, languages);
	}

	/**
	 * TermEntryからCSV行データを作成
	 *
	 * @param entry TermEntry
	 * @param allLanguages 対象言語のリスト（列順を保証）
	 */
	export function toCsvRow(entry: TermEntry, allLanguages: readonly string[]): Record<string, string> {
		const row: Record<string, string> = {
			context: entry.context,
		};

		for (const lang of allLanguages) {
			const langInfo = entry.languages[lang];
			if (!langInfo) {
				row[lang] = "";
				row[`variants_${lang}`] = "";
				continue;
			}

			row[lang] = langInfo.term;

			// 表記揺れを CSV 形式でエンコード
			if (langInfo.variants.length > 0) {
				row[`variants_${lang}`] = formatvariantsForCsv(langInfo.variants);
			} else {
				row[`variants_${lang}`] = "";
			}
		}

		return row;
	}

	/**
	 * CSVヘッダーから言語リストを抽出
	 *
	 * @param headers CSVヘッダー配列
	 */
	export function extractLanguagesFromHeaders(headers: readonly string[]): string[] {
		const languages = new Set<string>();

		for (const header of headers) {
			if (header === "context" || header.startsWith("variants_")) {
				continue;
			}
			// その他のヘッダーは言語コードとみなす
			if (header.trim()) {
				languages.add(header.trim());
			}
		}

		return Array.from(languages).sort();
	}

	/**
	 * CSV形式の表記揺れ文字列をパース
	 * "term1,term2,term3" または '"term1,term2,term3"' 形式に対応
	 */
	function parsevariantsFromCsv(text: string): string[] {
		if (!text) return [];

		// 二重引用符で囲まれている場合は除去
		const cleaned = text.replace(/^"(.*)"$/, "$1");

		// カンマ区切りで分割し、空文字列を除去
		return cleaned
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	/**
	 * 表記揺れリストをCSV形式にフォーマット
	 * カンマが含まれる場合は二重引用符で囲む
	 */
	function formatvariantsForCsv(variants: readonly string[]): string {
		if (variants.length === 0) return "";

		const joined = variants.join(",");

		// カンマや二重引用符が含まれる場合は二重引用符で囲む
		if (joined.includes(",") || joined.includes('"')) {
			return `"${joined.replace(/"/g, '""')}"`;
		}

		return joined;
	}
}
