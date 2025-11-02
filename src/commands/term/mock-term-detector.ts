import type * as vscode from "vscode";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { TermDetector } from "./term-detector";
import { TermEntry } from "./term-entry";

/**
 * モック用語検出実装（AI利用不可時のフォールバック）
 */
export class MockTermDetector implements TermDetector {
	async detectTerms(
		unit: MdaitUnit,
		sourceLang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]> {
		// キャンセルチェック
		if (cancellationToken?.isCancellationRequested) {
			return [];
		}

		// ユニットからテキストを抽出
		const lines = unit.content.split("\n");
		const contentWithoutHeading = lines.slice(1).join("\n").trim();

		if (!contentWithoutHeading) {
			return [];
		}

		// 用語候補を抽出
		const candidateTerms = this.extractCandidateTerms(contentWithoutHeading);

		// 既存用語があればそれらを除外
		const existingSet = new Set<string>();
		if (existingTerms) {
			for (const e of existingTerms) {
				const t = e.languages[sourceLang]?.term;
				if (t) existingSet.add(t.toLowerCase());
			}
		}

		const termEntries: TermEntry[] = candidateTerms
			.filter((t) => !existingSet.has(t.toLowerCase()))
			.map((term) =>
				TermEntry.create(unit.title || "Untitled Section", {
					[sourceLang]: {
						term: term,
						variants: [],
					},
				}),
			);

		return termEntries;
	}

	async detectTermsBatch(
		units: readonly MdaitUnit[],
		sourceLang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]> {
		// キャンセルチェック
		if (cancellationToken?.isCancellationRequested) {
			return [];
		}

		// 各ユニットから検出して統合
		const allTerms: TermEntry[] = [];
		for (const unit of units) {
			const terms = await this.detectTerms(unit, sourceLang, existingTerms, cancellationToken);
			allTerms.push(...terms);
		}

		return allTerms;
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
