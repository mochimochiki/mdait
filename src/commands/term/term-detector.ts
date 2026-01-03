/**
 * @file term-detector.ts
 * @description 用語検出に特化したサービス
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import type * as vscode from "vscode";
import type { AIService } from "../../api/ai-service";
import { AIServiceBuilder } from "../../api/ai-service-builder";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { PromptIds, PromptProvider } from "../../prompts";
import { MockTermDetector } from "./mock-term-detector";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";

/**
 * 用語検出サービスのインターフェース
 */
export interface TermDetector {
	/**
	 * 複数のMdaitUnitから重要用語をバッチ検出
	 *
	 * @param units 検出対象のユニット配列
	 * @param lang 言語コード
	 * @param existingTerms repository に既に存在するエントリのリスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 検出された用語エントリのリスト
	 */
	detectTermsBatch(
		units: readonly MdaitUnit[],
		lang: string,
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
	 * 複数のMdaitUnitから用語をバッチ検出
	 * 全ユニットの内容をまとめて1回のAI呼び出しで処理
	 */
	async detectTermsBatch(
		units: readonly MdaitUnit[],
		lang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]> {
		if (units.length === 0) {
			return [];
		}

		// 複数ユニットの内容を結合
		const combinedContent = units
			.map((unit, idx) => {
				const title = unit.title || `Section ${idx + 1}`;
				return `## ${title}\n${unit.content}`;
			})
			.join("\n\n");

		// 既存用語情報の準備
		let existingTermsList = "";
		if (existingTerms && existingTerms.length > 0) {
			const termsList = existingTerms
				.filter((e) => e.languages[lang])
				.map((e) => e.languages[lang].term)
				.slice(0, 50);
			if (termsList.length > 0) {
				existingTermsList = `- ${termsList.join("\n- ")}`;
			}
		}

		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TERM_DETECT, {
			lang,
			existingTerms: existingTermsList,
		});

		const userPrompt = `Extract important terms from this text:

Text:
${combinedContent}

Return JSON array only, no commentary.`;

		// ストリーミング応答を文字列に結合
		let response = "";
		const messageStream = this.aiService.sendMessage(
			systemPrompt,
			[{ role: "user", content: userPrompt }],
			cancellationToken,
		);

		for await (const chunk of messageStream) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				console.log("Term detection was cancelled");
				return [];
			}
			response += chunk;
		}

		return this.parseAIResponse(response, lang);
	}

	/**
	 * AI応答をTermEntryの配列に変換
	 */
	private parseAIResponse(response: string, lang: string): readonly TermEntry[] {
		try {
			// JSONブロックを抽出
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				throw new Error("JSONブロックが見つかりません");
			}

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) {
				throw new Error("配列形式ではありません");
			}

			return parsed
				.filter((item) => item.term && item.context)
				.map((item) =>
					TermEntryUtils.create(item.context, {
						[lang]: {
							term: item.term,
							variants: [],
						},
					}),
				);
		} catch (error) {
			console.warn("AI応答のパースに失敗しました:", error);
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
