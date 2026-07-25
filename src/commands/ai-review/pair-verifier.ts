/**
 * @file pair-verifier.ts
 * @description
 *   AI翻訳レビューのAI呼び出し層。
 *   system prompt を不変に保ち、リトライ時は user message 側に
 *   RETRY INSTRUCTION を追記する（translator.ts と同じキャッシュ維持パターン）。
 * @module commands/ai-review/pair-verifier
 */

import type * as vscode from "vscode";
import type { AIMessage, AIService } from "../../infra/llm/ai-service";
import { Logger, formatError } from "../../infra/logging/logger";
import { PromptIds } from "../../prompts";
import type { PromptParts, PromptVariables } from "../../prompts";
import type { PromptId } from "../../prompts";
import type { ValidationError } from "../trans/response-validator";
import type { ParsedVerifyResponse } from "./review-result";
import { type VerifyBatchPair, buildPairsBlock, escapeForTag } from "./verify-batch-format";
import { validateVerifyBatchResponse, validateVerifyResponse } from "./verify-response-validator";

/** 検証要求 */
export interface VerifyRequest {
	sourceLang: string;
	targetLang: string;
	sourceText: string;
	targetText: string;
	/**
	 * ユニットに紐づく人間の note（意図的な乖離の説明など）。
	 * 与えられた場合は user メッセージに <humanNote> として添え、AI が意図的乖離として織り込む。
	 */
	humanNote?: string;
	/** 用語集 JSON（原文・訳文どちらかにヒットしたエントリ。訳揺れ検知用） */
	termsJson?: string;
	/** TM参照（原文・訳文の双方向検索結果。訳揺れ検知用） */
	tmReferences?: string;
	/** ログ用コンテキスト */
	unitContext?: { unitHash?: string; title?: string };
	/**
	 * AI が reason / issues を書く言語（例: "Japanese (ja)"）。
	 * 省略時はプロンプト側の既定（英語）になる（ADR-260719-01）。
	 */
	responseLang?: string;
}

/** バッチ検証要求 */
export interface VerifyBatchRequest {
	sourceLang: string;
	targetLang: string;
	/** 検証対象ペア（index は 1-based 連番） */
	pairs: VerifyBatchPair[];
	/** AI が reason / issues を書く言語（例: "Japanese (ja)"） */
	responseLang?: string;
}

/** 検証結果（リトライ枯渇時は fallback: true で uncertain 相当を返す） */
export interface VerifyResult {
	parsed: ParsedVerifyResponse;
	/** リトライ枯渇により安全側（uncertain / confidence 0）へフォールバックしたか */
	fallback: boolean;
}

/**
 * reason / issues の記述言語指示を1行で組み立てる（テンプレートに `{{responseLang}}` が無い場合の補完用）。
 * 既に展開済みの user メッセージに言語名が含まれていれば二重指示にならないよう空文字を返す。
 *
 * @param userMessage 変数展開済みの user メッセージ
 * @param responseLang 記述言語（未指定ならプロンプト既定の英語のまま）
 */
function formatResponseLangLine(userMessage: string, responseLang?: string): string {
	if (!responseLang || userMessage.includes(responseLang)) {
		return "";
	}
	return `\n\nWrite "reason" and "issues" in ${responseLang}.`;
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
		// terms / tmReferences は外部データ（terms.csv・TMX 由来）。テンプレートの変数置換は
		// エスケープしないため、ここでエスケープして <terms>/<tmReferences> ラッパー内の
		// 「データ」として閉じ込める（humanNote と同じタグブレイク対策）。
		const promptParts = this.getPromptParts(PromptIds.AI_REVIEW_VERIFY_PAIRING, {
			sourceLang: request.sourceLang,
			targetLang: request.targetLang,
			sourceText: request.sourceText,
			targetText: request.targetText,
			terms: request.termsJson ? escapeForTag(request.termsJson) : "",
			tmReferences: request.tmReferences ? escapeForTag(request.tmReferences) : "",
			responseLang: request.responseLang ?? "",
		});

		// user-section 分割テンプレートでは userContext に全変数が展開される。
		// レガシー（マーカーなしカスタムプロンプト）では system に全展開されるため簡潔な指示のみ送る。
		const renderedUserMessage = promptParts.isLegacy
			? "Judge the pairing and return ONLY the JSON verdict object."
			: promptParts.userContext;
		// 表示言語の指示はテンプレートに依存せず届ける（`{{responseLang}}` を持たない
		// カスタム/レガシーテンプレートでも効かせる。humanNote と同じくコード側で添える）。
		const baseUserMessageRaw = `${renderedUserMessage}${formatResponseLangLine(renderedUserMessage, request.responseLang)}`;
		// 人間の note はプロンプトテンプレートに依存せず user メッセージ末尾に添える
		// （標準/レガシー/カスタムのいずれでも意図的乖離の説明が AI に届く）。
		// note は外部データなので山括弧をエスケープし、</humanNote> 等でラッパーを
		// 突破してプロンプトを注入されないよう「データ」として閉じ込める。
		const noteBlock = request.humanNote?.trim()
			? `\n\n<humanNote>\n${escapeForTag(request.humanNote.trim())}\n</humanNote>`
			: "";
		const baseUserMessage = `${baseUserMessageRaw}${noteBlock}`;

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
				Logger.getInstance().warn("aiReview", "Pairing verification retry", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					unitHash: request.unitContext?.unitHash,
					title: request.unitContext?.title,
				});
			}
		}

		Logger.getInstance().error("aiReview", "Pairing verification failed after all retry attempts", {
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
	 * 複数ペアを1回のLLM呼び出しで検証する。
	 *
	 * - 応答は `{"results": [...]}` 形式で、全ペア分の index が揃うまでバッチ全体をリトライする
	 * - リトライ枯渇時は部分受理: 最後に有効だったエントリはそのまま採用し、
	 *   欠落・不正だった index のみ uncertain / confidence 0（fallback: true）で埋める
	 *   （単ペア verify() の「不正応答→安全側 uncertain」をペア粒度に拡張した形）
	 */
	async verifyBatch(
		request: VerifyBatchRequest,
		cancellationToken?: vscode.CancellationToken,
	): Promise<Map<number, VerifyResult>> {
		const expectedIndices = request.pairs.map((pair) => pair.index);
		const pairsBlock = buildPairsBlock(request.pairs);
		const promptParts = this.getPromptParts(PromptIds.AI_REVIEW_VERIFY_PAIRING_BATCH, {
			sourceLang: request.sourceLang,
			targetLang: request.targetLang,
			pairCount: String(request.pairs.length),
			pairs: pairsBlock,
			responseLang: request.responseLang ?? "",
		});

		// レガシー（マーカーなしカスタムプロンプト）では変数が user 側に展開されないため、
		// 簡潔な指示とペアブロックをコードで連結して送る。
		const renderedUserMessage = promptParts.isLegacy
			? `Judge each pair independently and return ONLY the JSON results object.\n\n${pairsBlock}`
			: promptParts.userContext;
		// 単ペア経路と同じく、テンプレートに `{{responseLang}}` が無い場合はコード側で補う
		const baseUserMessage = `${renderedUserMessage}${formatResponseLangLine(renderedUserMessage, request.responseLang)}`;

		let lastError: ValidationError | undefined;
		let lastEntries = new Map<number, ParsedVerifyResponse>();

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (cancellationToken?.isCancellationRequested) {
				throw new Error("AI review cancelled");
			}

			const retrySuffix =
				attempt > 0 && lastError ? this.buildBatchRetryPromptSuffix(lastError, attempt, expectedIndices) : "";
			const messages: AIMessage[] = [
				{
					role: "user",
					content: `${baseUserMessage}${retrySuffix}`,
				},
			];

			const rawResponse = await this.aiService.sendMessage(promptParts.system, messages, cancellationToken);
			const validation = validateVerifyBatchResponse(rawResponse, expectedIndices);
			// 全体エラーでも有効なエントリは部分受理の候補として保持する（空応答では上書きしない）
			if (validation.entries.size > 0) {
				lastEntries = validation.entries;
			}
			if (!validation.error) {
				const results = new Map<number, VerifyResult>();
				for (const index of expectedIndices) {
					const parsed = validation.entries.get(index);
					if (parsed) {
						results.set(index, { parsed, fallback: false });
					}
				}
				return results;
			}

			lastError = validation.error;
			if (!lastError.retryable) {
				break;
			}

			if (attempt > 0) {
				Logger.getInstance().warn("aiReview", "Batch pairing verification retry", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					pairCount: request.pairs.length,
				});
			}
		}

		Logger.getInstance().error("aiReview", "Batch pairing verification incomplete after all retry attempts", {
			totalAttempts: this.maxRetries + 1,
			lastError: lastError ? formatError(lastError) : "No error details available",
			pairCount: request.pairs.length,
			acceptedCount: lastEntries.size,
		});

		// 部分受理: 有効だった判定は採用し、欠落分のみ安全側フォールバック
		const results = new Map<number, VerifyResult>();
		for (const index of expectedIndices) {
			const parsed = lastEntries.get(index);
			if (parsed) {
				results.set(index, { parsed, fallback: false });
			} else {
				results.set(index, {
					parsed: {
						verdict: "uncertain",
						confidence: 0,
						issues: [],
						reason: lastError ? `AI response invalid: ${lastError.message}` : "AI response invalid",
					},
					fallback: true,
				});
			}
		}
		return results;
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

	/**
	 * バッチ用リトライ補足プロンプト生成（欠落 index を明示して全件揃った応答を促す）
	 */
	private buildBatchRetryPromptSuffix(
		error: ValidationError,
		attemptNumber: number,
		expectedIndices: readonly number[],
	): string {
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Return ONLY a valid JSON object of the form {"results": [...]}.
- "results" must contain EXACTLY ${expectedIndices.length} entries, one per pair, with "index" values: ${expectedIndices.join(", ")}.
- "verdict" must be exactly one of: "match", "partial", "mismatch", "uncertain".
- "confidence" must be a number between 0.0 and 1.0.
- "issues" must be an array of strings.`;
	}
}
