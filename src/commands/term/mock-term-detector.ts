import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { TermDetector } from "./term-detector";
import { TermEntry } from "./term-entry";

/**
 * モック用語検出実装（AI利用不可時のフォールバック）
 */
export class MockTermDetector implements TermDetector {
	async detectTerms(unit: MdaitUnit, sourceLang: string): Promise<readonly TermEntry[]> {
		// ユニットからテキストを抽出
		const lines = unit.content.split("\n");
		const contentWithoutHeading = lines.slice(1).join("\n").trim();

		if (!contentWithoutHeading) {
			return [];
		}

		// 用語候補を抽出
		const candidateTerms = this.extractCandidateTerms(contentWithoutHeading);

		// TermEntryオブジェクトに変換
		const termEntries: TermEntry[] = candidateTerms.map((term) =>
			TermEntry.create(unit.title || "Untitled Section", {
				[sourceLang]: {
					term: term,
					variants: [],
				},
			}),
		);

		return termEntries;
	}

	private extractCandidateTerms(text: string): string[] {
		// 簡単なパターンで専門用語らしきものを抽出
		const candidates: string[] = [];

		// カタカナ用語（日本語の場合）
		const katakanaTerms = text.match(/[ァ-ヴー]{3,}/g) || [];
		candidates.push(...katakanaTerms);

		// 英数字を含む用語
		const alphanumericTerms = text.match(/[A-Za-z][A-Za-z0-9\-_.]{2,}/g) || [];
		candidates.push(...alphanumericTerms);

		// 重複除去と長すぎるものの除外
		return [...new Set(candidates)].filter((term) => term.length >= 3 && term.length <= 30).slice(0, 5); // 最大5個
	}
}
