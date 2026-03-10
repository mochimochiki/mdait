/**
 * @file sentence-aligner.ts
 * @description
 *   LLMベースの対訳文アライメント。
 *   原文/訳文ペアを入力し、文単位の対訳ペア配列を返す。
 * @module commands/tm/sentence-aligner
 */
import type * as vscode from "vscode";
import { stripMarkdown } from "../../core/tm/tm-text-normalizer";
import type { SentencePair } from "../../core/tm/types";
import type { AIMessage, AIService } from "../../llm/ai-service";
import { PromptIds, PromptProvider } from "../../prompts";
import { Logger, formatError } from "../../utils/logger";

const logger = Logger.getInstance();

/**
 * LLMによる対訳文の高精度アライメントを行うクラス。
 * tm-commit時にソースとターゲットの文を1:1にアラインする。
 */
export class SentenceAligner {
	private readonly aiService: AIService;

	constructor(aiService: AIService) {
		this.aiService = aiService;
	}

	/**
	 * ソーステキストとターゲットテキストを文単位にアラインする。
	 * @param sourceText ソースユニット本文
	 * @param targetText ターゲットユニット本文
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @param cancellationToken キャンセルトークン
	 * @returns 対訳文ペア配列
	 */
	async alignSentences(
		sourceText: string,
		targetText: string,
		sourceLang: string,
		targetLang: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<SentencePair[]> {
		// Markdown要素を除去して純粋なテキストに変換（LLMの負荷軽減と表などの複数行構造の正しい処理）
		const strippedSource = stripMarkdown(sourceText);
		const strippedTarget = stripMarkdown(targetText);

		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TM_SPLIT_SENTENCES, {
			sourceLang,
			targetLang,
			sourceText: strippedSource,
			targetText: strippedTarget,
		});

		const messages: AIMessage[] = [
			{
				role: "user",
				content: `Split and align the source (${sourceLang}) and target (${targetLang}) texts into sentence pairs.`,
			},
		];

		const response = await this.aiService.sendMessage(systemPrompt, messages, cancellationToken);

		return this.parseResponse(response);
	}

	/**
	 * LLMレスポンスをパースしてSentencePair配列を返す。
	 * @param response LLMからのJSON文字列レスポンス
	 * @returns パース済みの対訳ペア配列
	 */
	parseResponse(response: string): SentencePair[] {
		try {
			// JSONコードブロックのマーカーを除去
			const cleaned = response
				.replace(/^```(?:json)?\s*/m, "")
				.replace(/\s*```$/m, "")
				.trim();

			const parsed: unknown = JSON.parse(cleaned);

			if (!Array.isArray(parsed)) {
				logger.warn("tm.commit", "LLM response is not an array", { response: cleaned.substring(0, 200) });
				return [];
			}

			const pairs: SentencePair[] = [];
			for (const item of parsed) {
				if (
					typeof item === "object" &&
					item !== null &&
					typeof (item as Record<string, unknown>).source === "string" &&
					typeof (item as Record<string, unknown>).target === "string"
				) {
					const source = ((item as Record<string, unknown>).source as string).trim();
					const target = ((item as Record<string, unknown>).target as string).trim();
					if (source && target) {
						pairs.push({ source, target });
					}
				}
			}

			return pairs;
		} catch (error) {
			logger.warn("tm.commit", "Failed to parse LLM alignment response", {
				...formatError(error),
				response: response.substring(0, 200),
			});
			return [];
		}
	}
}
