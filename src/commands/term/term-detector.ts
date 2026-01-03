/**
 * @file term-detector.ts
 * @description 用語検出に特化したサービス
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import type * as vscode from "vscode";
import type { AIService } from "../../api/ai-service";
import { AIServiceBuilder } from "../../api/ai-service-builder";
import { PromptIds, PromptProvider } from "../../prompts";
import { MockTermDetector } from "./mock-term-detector";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";
import { UnitPair } from "./unit-pair";

/**
 * 用語検出サービスのインターフェース
 */
export interface TermDetector {
	/**
	 * UnitPairから用語を検出（統合メソッド）
	 * 対訳ペアがあれば両言語の用語を同時抽出、なければソース単独で処理
	 *
	 * @param pairs ユニットペア配列
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @param primaryLang context優先言語コード
	 * @param existingTerms 既存用語エントリのリスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 検出された用語エントリのリスト
	 */
	detectTerms(
		pairs: readonly UnitPair[],
		sourceLang: string,
		targetLang: string,
		primaryLang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]>;
}

/**
 * AIサービスを使用する用語検出実装
 */
export class AITermDetector implements TermDetector {
	private readonly aiService: AIService;
	private readonly fallbackDetector: MockTermDetector;

	constructor(aiService: AIService) {
		this.aiService = aiService;
		this.fallbackDetector = new MockTermDetector();
	}

	/**
	 * UnitPairから用語を検出（統合メソッド）
	 * 対訳ペアがあれば両言語の用語を同時抽出、なければソース単独で処理
	 */
	async detectTerms(
		pairs: readonly UnitPair[],
		sourceLang: string,
		targetLang: string,
		primaryLang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]> {
		if (pairs.length === 0) {
			return [];
		}

		// ペアを対訳あり/なしで分類
		const pairedUnits = pairs.filter((p) => UnitPair.hasTarget(p));
		const unpairedUnits = pairs.filter((p) => !UnitPair.hasTarget(p));

		const allTerms: TermEntry[] = [];

		// 対訳ペアありの処理
		if (pairedUnits.length > 0) {
			const pairsTerms = await this.detectTermsFromPairs(
				pairedUnits,
				sourceLang,
				targetLang,
				primaryLang,
				existingTerms,
				cancellationToken,
			);
			allTerms.push(...pairsTerms);
		}

		// ソース単独の処理
		if (unpairedUnits.length > 0 && !cancellationToken?.isCancellationRequested) {
			const sourceOnlyTerms = await this.detectTermsFromSourceOnly(
				unpairedUnits,
				sourceLang,
				existingTerms,
				cancellationToken,
			);
			allTerms.push(...sourceOnlyTerms);
		}

		return allTerms;
	}

	/**
	 * 対訳ペアから用語を検出
	 */
	private async detectTermsFromPairs(
		pairs: readonly UnitPair[],
		sourceLang: string,
		targetLang: string,
		primaryLang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<TermEntry[]> {
		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const contextLang =
			primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

		const existingTermsList = this.buildExistingTermsList(existingTerms, sourceLang, targetLang);
		const pairsText = this.buildPairsText(pairs, sourceLang, targetLang);

		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TERM_DETECT_PAIRS, {
			sourceLang,
			targetLang,
			contextLang,
			existingTerms: existingTermsList,
			pairs: pairsText,
		});

		const userPrompt = `Extract important terms from the provided translation pairs.
Return JSON array only, no commentary.`;

		const response = await this.callAI(systemPrompt, userPrompt, cancellationToken);
		if (!response) {
			return [];
		}

		return this.parseDetectPairsResponse(response, sourceLang, targetLang);
	}

	/**
	 * ソース単独から用語を検出
	 */
	private async detectTermsFromSourceOnly(
		pairs: readonly UnitPair[],
		sourceLang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<TermEntry[]> {
		const existingTermsList = this.buildExistingTermsList(existingTerms, sourceLang, sourceLang);
		const sourceText = this.buildSourceOnlyText(pairs);

		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TERM_DETECT_SOURCE_ONLY, {
			sourceLang,
			existingTerms: existingTermsList,
			sourceText,
		});

		const userPrompt = `Extract important terms from the provided source text.
Return JSON array only, no commentary.`;

		const response = await this.callAI(systemPrompt, userPrompt, cancellationToken);
		if (!response) {
			return [];
		}

		return this.parseDetectSourceOnlyResponse(response, sourceLang);
	}

	/**
	 * AIサービスを呼び出してレスポンスを取得
	 */
	private async callAI(
		systemPrompt: string,
		userPrompt: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		let response = "";
		const messageStream = this.aiService.sendMessage(
			systemPrompt,
			[{ role: "user", content: userPrompt }],
			cancellationToken,
		);

		for await (const chunk of messageStream) {
			if (cancellationToken?.isCancellationRequested) {
				console.log("Term detection was cancelled");
				return "";
			}
			response += chunk;
		}

		return response;
	}

	/**
	 * 既存用語リストをテキスト形式で構築
	 */
	private buildExistingTermsList(
		existingTerms: readonly TermEntry[] | undefined,
		sourceLang: string,
		targetLang: string,
	): string {
		if (!existingTerms || existingTerms.length === 0) {
			return "";
		}

		const termsList = existingTerms
			.filter((e) => e.languages[sourceLang] || e.languages[targetLang])
			.map((e) => {
				const source = e.languages[sourceLang]?.term || "";
				const target = e.languages[targetLang]?.term || "";
				if (source && target) {
					return `- ${source} / ${target}`;
				}
				return `- ${source || target}`;
			})
			.slice(0, 50);

		return termsList.length > 0 ? termsList.join("\n") : "";
	}

	/**
	 * 対訳ペアのテキストを構築
	 */
	private buildPairsText(pairs: readonly UnitPair[], sourceLang: string, targetLang: string): string {
		if (pairs.length === 0) {
			return "";
		}

		return pairs
			.map((pair, idx) => {
				const sourceTitle = pair.source.title || `Section ${idx + 1}`;
				const targetTitle = pair.target?.title || sourceTitle;
				return `
### Pair ${idx + 1}: ${sourceTitle}
**Source (${sourceLang}):**
${pair.source.content}

**Target (${targetLang}):**
${pair.target?.content || "(no translation)"}`;
			})
			.join("\n\n");
	}

	/**
	 * ソース単独テキストを構築
	 */
	private buildSourceOnlyText(pairs: readonly UnitPair[]): string {
		if (pairs.length === 0) {
			return "";
		}

		return pairs
			.map((pair, idx) => {
				const title = pair.source.title || `Section ${idx + 1}`;
				return `## ${title}\n${pair.source.content}`;
			})
			.join("\n\n");
	}

	/**
	 * 対訳ペア用のAI応答をパース
	 */
	private parseDetectPairsResponse(response: string, sourceLang: string, targetLang: string): TermEntry[] {
		try {
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				throw new Error("JSONブロックが見つかりません");
			}

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) {
				throw new Error("配列形式ではありません");
			}

			return parsed
				.filter((item) => item.sourceTerm && item.targetTerm && item.context)
				.map((item) => {
					const languages: Record<string, { term: string; variants: readonly string[] }> = {
						[sourceLang]: {
							term: item.sourceTerm,
							variants: [],
						},
						[targetLang]: {
							term: item.targetTerm,
							variants: [],
						},
					};

					return TermEntryUtils.create(item.context, languages);
				});
		} catch (error) {
			console.warn("対訳ペア用語検出のパースに失敗しました:", error);
			return [];
		}
	}

	/**
	 * ソース単独用のAI応答をパース
	 */
	private parseDetectSourceOnlyResponse(response: string, sourceLang: string): TermEntry[] {
		try {
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				throw new Error("JSONブロックが見つかりません");
			}

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) {
				throw new Error("配列形式ではありません");
			}

			return parsed
				.filter((item) => item.sourceTerm && item.context)
				.map((item) => {
					const languages: Record<string, { term: string; variants: readonly string[] }> = {
						[sourceLang]: {
							term: item.sourceTerm,
							variants: [],
						},
					};

					return TermEntryUtils.create(item.context, languages);
				});
		} catch (error) {
			console.warn("ソース単独用語検出のパースに失敗しました:", error);
			return [];
		}
	}
}

/**
 * デフォルトの用語検出サービスを作成
 */
export async function createTermDetector(): Promise<TermDetector> {
	try {
		const builder = new AIServiceBuilder();
		const aiService = await builder.build();
		return new AITermDetector(aiService);
	} catch (error) {
		console.warn("AI用語検出サービスの初期化に失敗しました。モック実装を使用します:", error);
		return new MockTermDetector();
	}
}
