/**
 * @file pair-verifier.ts
 * @description
 *   AIペアリング検証のAI呼び出し層。
 *   system prompt を不変に保ち、リトライ時は user message 側に
 *   RETRY INSTRUCTION を追記する（translator.ts と同じキャッシュ維持パターン）。
 * @module commands/ai-sync/pair-verifier
 */

import type * as vscode from "vscode";
import type { AIMessage, AIService } from "../../infra/llm/ai-service";
import { Logger, formatError } from "../../infra/logging/logger";
import { PromptIds } from "../../prompts";
import type { PromptParts, PromptVariables } from "../../prompts";
import type { PromptId } from "../../prompts";
import type { ValidationError } from "../trans/response-validator";
import type { ParsedVerifyResponse } from "./review-result";
import { validateVerifyResponse } from "./verify-response-validator";

/** 検証要求 */
export interface VerifyRequest {
	sourceLang: string;
	targetLang: string;
	sourceText: string;
	targetText: string;
	/** ログ用コンテキスト */
	unitContext?: { unitHash?: string; title?: string };
}

/** 検証結果（リトライ枯渇時は fallback: true で uncertain 相当を返す） */
export interface VerifyResult {
	parsed: ParsedVerifyResponse;
	/** リトライ枯渇により安全側（uncertain / confidence 0）へフォールバックしたか */
	fallback: boolean;
}

/**
 * ソース・ターゲットユニットペアの妥当性を LLM で検証するクラス。
 */
export class PairVerifier {
	private readonly aiService: AIService;
	private readonly getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts;
	private readonly maxRetries: number;

	constructor(
		aiService: AIService,
		getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts,
		maxRetries = 2,
	) {
		this.aiService = aiService;
		this.getPromptParts = getPromptParts;
		this.maxRetries = maxRetries;
	}

	/**
	 * 1ペアを検証する。
	 * 不正応答はリトライし、枯渇時は uncertain / confidence 0 相当へフォールバックする
	 * （自動承認されない安全側。1ユニットの失敗でファイル全体を止めない）。
	 */
	async verify(request: VerifyRequest, cancellationToken?: vscode.CancellationToken): Promise<VerifyResult> {
		const promptParts = this.getPromptParts(PromptIds.AI_SYNC_VERIFY_PAIRING, {
			sourceLang: request.sourceLang,
			targetLang: request.targetLang,
			sourceText: request.sourceText,
			targetText: request.targetText,
		});

		// user-section 分割テンプレートでは userContext に全変数が展開される。
		// レガシー（マーカーなしカスタムプロンプト）では system に全展開されるため簡潔な指示のみ送る。
		const baseUserMessage = promptParts.isLegacy
			? "Judge the pairing and return ONLY the JSON verdict object."
			: promptParts.userContext;

		let lastError: ValidationError | undefined;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (cancellationToken?.isCancellationRequested) {
				throw new Error("AI review cancelled");
			}

			const retrySuffix = attempt > 0 && lastError ? this.buildRetryPromptSuffix(lastError, attempt) : "";
			const messages: AIMessage[] = [
				{
					role: "user",
					content: `${baseUserMessage}${retrySuffix}`,
				},
			];

			const rawResponse = await this.aiService.sendMessage(promptParts.system, messages, cancellationToken);
			const validation = validateVerifyResponse(rawResponse);
			if (validation.valid && validation.parsed) {
				return { parsed: validation.parsed, fallback: false };
			}

			lastError = validation.error;
			if (!lastError?.retryable) {
				break;
			}

			if (attempt > 0) {
				Logger.getInstance().warn("aiSync", "Pairing verification retry", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					unitHash: request.unitContext?.unitHash,
					title: request.unitContext?.title,
				});
			}
		}

		Logger.getInstance().error("aiSync", "Pairing verification failed after all retry attempts", {
			totalAttempts: this.maxRetries + 1,
			lastError: lastError ? formatError(lastError) : "No error details available",
			unitHash: request.unitContext?.unitHash,
			title: request.unitContext?.title,
		});

		// 安全側フォールバック: uncertain / confidence 0（自動承認されない）
		return {
			parsed: {
				verdict: "uncertain",
				confidence: 0,
				issues: [],
				reason: lastError ? `AI response invalid: ${lastError.message}` : "AI response invalid",
			},
			fallback: true,
		};
	}

	/**
	 * リトライ用補足プロンプト生成（user message 末尾に追記し system を不変に保つ）
	 */
	private buildRetryPromptSuffix(error: ValidationError, attemptNumber: number): string {
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Return ONLY a valid JSON object.
- "verdict" must be exactly one of: "match", "partial", "mismatch", "uncertain".
- "confidence" must be a number between 0.0 and 1.0.
- "issues" must be an array of strings.`;
	}
}
