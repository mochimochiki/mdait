import type * as vscode from "vscode";
import type { AIMessage, AIService } from "../../api/ai-service";
import { Configuration } from "../../config/configuration";
import { PromptIds, PromptProvider } from "../../prompts";
import { sanitizeTranslationOutput } from "./output-sanitizer";
import {
	type ParsedRevisionPatchResponse,
	type ParsedTranslationResponse,
	type ValidationError,
	type ValidationResult,
	validateRevisionPatchResponse,
	validateTranslationResponse,
} from "./response-validator";
import type { TranslationContext } from "./translation-context";

/**
 * 用語候補情報
 */
export interface TermSuggestion {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** 用語が使用されている実際の文脈（contextLang言語からの引用） */
	context: string;
	/** 用語集に追加すべき理由（オプショナル） */
	reason?: string;
}

/**
 * 翻訳結果
 * 翻訳されたテキストと追加のメタデータを含む
 */
export interface TranslationResult {
	/** 翻訳されたテキスト */
	translatedText: string;
	/** AIが提案する用語候補のリスト */
	termSuggestions?: TermSuggestion[];
	/** 警告メッセージ */
	warnings?: string[];
	/** 統計情報（将来の拡張用） */
	stats?: {
		/** 推定使用トークン数 */
		estimatedTokens?: number;
	};
}

/**
 * 改訂パッチ翻訳結果
 */
export interface RevisionPatchResult {
	/** 前回訳文に対するunified diffパッチ */
	targetPatch: string;
	/** AIが提案する用語候補のリスト */
	termSuggestions?: TermSuggestion[];
	/** 警告メッセージ */
	warnings?: string[];
	/** 統計情報（将来の拡張用） */
	stats?: {
		/** 推定使用トークン数 */
		estimatedTokens?: number;
	};
}

/**
 * 翻訳サービスのインターフェース
 */
export interface Translator {
	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
	): Promise<TranslationResult>;

	/**
	 * 改訂時のパッチ翻訳を実行する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 改訂パッチ翻訳結果
	 */
	translateRevisionPatch(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
	): Promise<RevisionPatchResult>;
}

/**
 * AI翻訳サービス実装
 */
export class AITranslator implements Translator {
	private readonly aiService: AIService;
	/** 最大リトライ回数 */
	private readonly maxRetries = 2;

	constructor(aiService: AIService) {
		this.aiService = aiService;
	}

	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	async translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
	): Promise<TranslationResult> {
		// コードブロックをスキップするロジック
		const codeBlockRegex = /```[\s\S]*?```/g;
		const codeBlocks: string[] = [];
		const placeholders: string[] = [];

		const textWithoutCodeBlocks = text.replace(codeBlockRegex, (match) => {
			const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
			codeBlocks.push(match);
			placeholders.push(placeholder);
			return placeholder;
		});

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const config = Configuration.getInstance();
		const primaryLang = config.getTermsPrimaryLang();
		const contextLang = primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

		// systemPrompt と AIMessage[] の構築
		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang,
			targetLang,
			contextLang,
			surroundingText: context.surroundingText,
			terms: context.terms,
			previousTranslation: context.previousTranslation,
			sourceDiff: context.sourceDiff,
		});

		const messages: AIMessage[] = [
			{
				role: "user",
				content: textWithoutCodeBlocks,
			},
		];

		// リトライ付きでAI呼び出し
		return await this.executeTranslationWithRetry(systemPrompt, messages, codeBlocks, placeholders, cancellationToken);
	}

	/**
	 * 改訂パッチ翻訳を実行する
	 */
	async translateRevisionPatch(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
	): Promise<RevisionPatchResult> {
		// コードブロックをスキップするロジック
		const codeBlockRegex = /```[\s\S]*?```/g;
		const codeBlocks: string[] = [];
		const placeholders: string[] = [];

		const textWithoutCodeBlocks = text.replace(codeBlockRegex, (match) => {
			const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
			codeBlocks.push(match);
			placeholders.push(placeholder);
			return placeholder;
		});

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const config = Configuration.getInstance();
		const primaryLang = config.getTermsPrimaryLang();
		const contextLang = primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TRANS_REVISE_PATCH, {
			sourceLang,
			targetLang,
			contextLang,
			surroundingText: context.surroundingText,
			terms: context.terms,
			previousTranslation: context.previousTranslation,
			sourceDiff: context.sourceDiff,
		});

		const messages: AIMessage[] = [
			{
				role: "user",
				content: textWithoutCodeBlocks,
			},
		];

		// リトライ付きでAI呼び出し
		return await this.executeRevisionPatchWithRetry(
			systemPrompt,
			messages,
			codeBlocks,
			placeholders,
			cancellationToken,
		);
	}

	/**
	 * リトライ付き翻訳実行
	 */
	private async executeTranslationWithRetry(
		systemPrompt: string,
		messages: AIMessage[],
		codeBlocks: string[],
		placeholders: string[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<TranslationResult> {
		let lastError: ValidationError | undefined;
		let lastRawResponse = "";

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				throw new Error("Translation cancelled");
			}

			// リトライ時は補足プロンプトを追加
			const retryPromptSuffix = attempt > 0 && lastError ? this.buildRetryPromptSuffix(lastError, attempt) : "";
			const finalSystemPrompt = systemPrompt + retryPromptSuffix;

			lastRawResponse = await this.aiService.sendMessage(finalSystemPrompt, messages, cancellationToken);
			const validation = validateTranslationResponse(lastRawResponse);

			if (validation.valid && validation.parsed) {
				// バリデーション成功 → サニタイズ処理
				return this.processValidTranslationResponse(validation.parsed, codeBlocks, placeholders);
			}

			lastError = validation.error;

			// リトライ不可能なエラーは即座にフォールバック
			if (!lastError?.retryable) {
				break;
			}

			console.warn(`Translation validation failed (attempt ${attempt + 1}): ${lastError.message}`);
		}

		// フォールバック処理
		return this.createTranslationFallbackResult(lastRawResponse, codeBlocks, placeholders, lastError);
	}

	/**
	 * リトライ付き改訂パッチ翻訳実行
	 */
	private async executeRevisionPatchWithRetry(
		systemPrompt: string,
		messages: AIMessage[],
		codeBlocks: string[],
		placeholders: string[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<RevisionPatchResult> {
		let lastError: ValidationError | undefined;
		let lastRawResponse = "";

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				throw new Error("Translation cancelled");
			}

			// リトライ時は補足プロンプトを追加
			const retryPromptSuffix = attempt > 0 && lastError ? this.buildRetryPromptSuffix(lastError, attempt) : "";
			const finalSystemPrompt = systemPrompt + retryPromptSuffix;

			lastRawResponse = await this.aiService.sendMessage(finalSystemPrompt, messages, cancellationToken);
			const validation = validateRevisionPatchResponse(lastRawResponse);

			if (validation.valid && validation.parsed) {
				// バリデーション成功 → サニタイズ処理
				return this.processValidRevisionPatchResponse(validation.parsed, codeBlocks, placeholders);
			}

			lastError = validation.error;

			// リトライ不可能なエラーは即座にフォールバック
			if (!lastError?.retryable) {
				break;
			}

			console.warn(`Revision patch validation failed (attempt ${attempt + 1}): ${lastError.message}`);
		}

		// フォールバック処理
		return this.createRevisionPatchFallbackResult(lastRawResponse, codeBlocks, placeholders, lastError);
	}

	/**
	 * 有効な翻訳レスポンスを処理
	 */
	private processValidTranslationResponse(
		parsed: ParsedTranslationResponse,
		codeBlocks: string[],
		placeholders: string[],
	): TranslationResult {
		let content = parsed.translation;

		// プレースホルダー復元
		for (let i = 0; i < placeholders.length; i++) {
			content = content.replaceAll(placeholders[i], codeBlocks[i]);
		}

		// サニタイズ処理
		const sanitized = sanitizeTranslationOutput(content);

		return {
			translatedText: sanitized.text,
			termSuggestions: parsed.termSuggestions ?? [],
			warnings: [...sanitized.warnings, ...(parsed.warnings ?? [])],
		};
	}

	/**
	 * 有効な改訂パッチレスポンスを処理
	 */
	private processValidRevisionPatchResponse(
		parsed: ParsedRevisionPatchResponse,
		codeBlocks: string[],
		placeholders: string[],
	): RevisionPatchResult {
		let content = parsed.targetPatch;

		// プレースホルダー復元
		for (let i = 0; i < placeholders.length; i++) {
			content = content.replaceAll(placeholders[i], codeBlocks[i]);
		}

		// サニタイズ処理
		const sanitized = sanitizeTranslationOutput(content);

		return {
			targetPatch: sanitized.text,
			termSuggestions: parsed.termSuggestions ?? [],
			warnings: [...sanitized.warnings, ...(parsed.warnings ?? [])],
		};
	}

	/**
	 * 翻訳フォールバック結果生成
	 */
	private createTranslationFallbackResult(
		rawResponse: string,
		codeBlocks: string[],
		placeholders: string[],
		error?: ValidationError,
	): TranslationResult {
		let text = rawResponse;
		for (let i = 0; i < placeholders.length; i++) {
			text = text.replaceAll(placeholders[i], codeBlocks[i]);
		}

		const sanitized = sanitizeTranslationOutput(text);

		return {
			translatedText: sanitized.text,
			termSuggestions: [],
			warnings: [`AI response format was unexpected: ${error?.message ?? "unknown error"}`, ...sanitized.warnings],
		};
	}

	/**
	 * 改訂パッチフォールバック結果生成
	 */
	private createRevisionPatchFallbackResult(
		rawResponse: string,
		codeBlocks: string[],
		placeholders: string[],
		error?: ValidationError,
	): RevisionPatchResult {
		let text = rawResponse;
		for (let i = 0; i < placeholders.length; i++) {
			text = text.replaceAll(placeholders[i], codeBlocks[i]);
		}

		const sanitized = sanitizeTranslationOutput(text);

		return {
			targetPatch: sanitized.text,
			termSuggestions: [],
			warnings: [`AI response format was unexpected: ${error?.message ?? "unknown error"}`, ...sanitized.warnings],
		};
	}

	/**
	 * リトライ用補足プロンプト生成
	 */
	private buildRetryPromptSuffix(error: ValidationError, attemptNumber: number): string {
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Return ONLY a valid JSON object with the required fields.
- The "translation" or "targetPatch" field must contain PLAIN TEXT, not JSON.
- Do NOT nest JSON inside the translation or targetPatch field.`;
	}
}
