import type * as vscode from "vscode";
import { OperationCancelledError } from "../../infra/errors/operation-cancelled";
import type { AIMessage, AIService } from "../../infra/llm/ai-service";
import { PromptIds } from "../../prompts/defaults";
import type { PromptId } from "../../prompts/defaults";
import type {
	PromptParts,
	PromptVariables,
} from "../../prompts/prompt-provider";
import { buildUserMessage } from "../../prompts/prompt-provider";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
import { Logger, formatError } from "../../infra/logging/logger";
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

/** コードブロックを退避した結果 */
export interface ProtectedCodeBlocks {
	/** コードブロックをプレースホルダへ置き換えたテキスト（AI へ渡す形） */
	text: string;
	/** 退避したコードブロック（行まるごと。字下げや引用記号を含む） */
	codeBlocks: string[];
	/** プレースホルダ（codeBlocks と同じ並び） */
	placeholders: string[];
}

/** コードブロックを戻した結果 */
export interface RestoredCodeBlocks {
	/** コードブロックを復元したテキスト */
	text: string;
	/** AI の応答から消えていて戻せなかったプレースホルダ */
	missing: string[];
}

/**
 * コードブロックを AI へ渡さないように退避する。
 *
 * 「どこがコードブロックか」はパーサーと同じ `getCodeBlockLineSet`（markdown-it）に問う。
 * 独自の正規表現で探すと、```` ``` ```` しか拾えない・`~~~`・字下げコードブロック・4連
 * バッククォートを取りこぼす／誤分割する。同じ問いに2つの答えを持たない（design.md P9）。
 *
 * 退避は**行まるごと**で行う。リスト項目の中や引用の中のコードブロックは行頭に字下げや
 * `> ` が付くため、バッククォートの位置から切り出すと前置きがプレースホルダの手前に残り、
 * 戻すときに行の途中と誤判定される。行ごと退避すれば前置きもブロックに含まれ、
 * 元どおりに戻る。
 *
 * コードブロックでない行に残った行内の ```` ```...``` ````（インラインのコード）も、
 * 従来どおり翻訳させずに退避する。こちらは1行内で完結するので改行の補いは要らない。
 *
 * @param text 退避対象のテキスト
 * @returns 退避結果
 */
export function protectCodeBlocks(text: string): ProtectedCodeBlocks {
	const lines = text.split("\n");
	const codeBlockLines = getCodeBlockLineSet(text);
	const out: string[] = [];
	const codeBlocks: string[] = [];
	const placeholders: string[] = [];

	const take = (block: string): string => {
		const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
		codeBlocks.push(block);
		placeholders.push(placeholder);
		return placeholder;
	};

	// 行内で完結する ```...```（インラインのコード）。改行をまたがせないことで、
	// 離れた場所にある無関係なバッククォート同士を1つの塊にしてしまう事故を防ぐ。
	const inlineCodeRegex = /```[^\n]*?```/g;

	let i = 0;
	while (i < lines.length) {
		if (!codeBlockLines.has(i)) {
			out.push(lines[i].replace(inlineCodeRegex, (match) => take(match)));
			i++;
			continue;
		}
		// 連続するコードブロック行をひとまとまりとして退避する
		let end = i;
		while (end < lines.length && codeBlockLines.has(end)) {
			end++;
		}
		out.push(take(lines.slice(i, end).join("\n")));
		i = end;
	}

	return { text: out.join("\n"), codeBlocks, placeholders };
}

/**
 * コードブロックのプレースホルダを元のコードブロックへ戻す。
 *
 * `protectCodeBlocks` はプレースホルダを必ず1行として置くので、AI が形を保っていれば
 * そのまま行が入れ替わり原文どおりに戻る。ただし AI がプレースホルダを前後の文と
 * つなげて1行にまとめることは実際に起きる。そのとき複数行のブロックが行の途中に戻ると
 * 開始フェンスが行頭に来ず Markdown としてコードブロックでなくなり、中身（サンプルの
 * 見出しや mdait マーカー風の文字列）が本文として読まれてユニット境界を誤る
 * （design.md P9）。そのため行頭・行末へ来るよう改行を補う。
 *
 * @param text プレースホルダを含むテキスト
 * @param placeholders プレースホルダ文字列（codeBlocks と同じ並び）
 * @param codeBlocks 元のコードブロック文字列
 * @returns 復元したテキストと、戻せなかったプレースホルダ
 */
export function restoreCodeBlocks(
	text: string,
	placeholders: string[],
	codeBlocks: string[],
): RestoredCodeBlocks {
	let result = text;
	const missing: string[] = [];

	for (let i = 0; i < placeholders.length; i++) {
		const placeholder = placeholders[i];
		const block = codeBlocks[i];
		const isMultiline = block.includes("\n");
		let searchFrom = 0;
		let found = false;
		while (true) {
			const idx = result.indexOf(placeholder, searchFrom);
			if (idx === -1) {
				break;
			}
			found = true;
			const before = result.slice(0, idx);
			const after = result.slice(idx + placeholder.length);
			const leading = isMultiline && before !== "" && !before.endsWith("\n") ? "\n" : "";
			const trailing = isMultiline && after !== "" && !after.startsWith("\n") ? "\n" : "";
			const replacement = `${leading}${block}${trailing}`;
			result = before + replacement + after;
			searchFrom = before.length + replacement.length;
		}
		if (!found) {
			missing.push(placeholder);
		}
	}

	return { text: result, missing };
}

/** 戻せなかったコードブロックがあれば警告文にする（黙って消さない） */
function codeBlockLossWarnings(missing: string[]): string[] {
	if (missing.length === 0) {
		return [];
	}
	return [
		`AI response dropped ${missing.length} code block(s); they could not be restored: ${missing.join(", ")}`,
	];
}

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
	 * @param unitContext ログ用ユニット情報
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult>;

	/**
	 * 改訂時のパッチ翻訳を実行する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @param unitContext ログ用ユニット情報
	 * @returns 改訂パッチ翻訳結果
	 */
	translateRevisionPatch(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionPatchResult>;
}

/**
 * Translatorが使用するプロンプトIDの設定
 * デフォルトはMarkdown用プロンプト
 */
export interface TranslatorPromptConfig {
	translatePromptId: PromptId;
	revisePatchPromptId: PromptId;
}

/** Markdown用のデフォルトプロンプト設定 */
const DEFAULT_MD_PROMPT_CONFIG: TranslatorPromptConfig = {
	translatePromptId: PromptIds.TRANS_TRANSLATE,
	revisePatchPromptId: PromptIds.TRANS_REVISE_PATCH,
};

/** 非MDファイル用のプロンプト設定 */
export const PLAIN_PROMPT_CONFIG: TranslatorPromptConfig = {
	translatePromptId: PromptIds.TRANS_TRANSLATE_PLAIN,
	revisePatchPromptId: PromptIds.TRANS_REVISE_PATCH_PLAIN,
};

/**
 * AI翻訳サービス実装
 */
export class AITranslator implements Translator {
	private readonly aiService: AIService;
	private readonly primaryLang: string;
	private readonly getPromptParts: (
		id: PromptId,
		variables?: PromptVariables,
	) => PromptParts;
	private readonly promptConfig: TranslatorPromptConfig;
	/** 最大リトライ回数。通常は `TranslatorBuilder` が `trans.retryLimit` を渡す（コンストラクタ引数省略時のみ 2） */
	private readonly maxRetries: number;

	constructor(
		aiService: AIService,
		primaryLang: string,
		getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts,
		promptConfig?: TranslatorPromptConfig,
		retryLimit?: number,
	) {
		this.aiService = aiService;
		this.primaryLang = primaryLang;
		this.getPromptParts = getPromptParts;
		this.promptConfig = promptConfig ?? DEFAULT_MD_PROMPT_CONFIG;
		this.maxRetries = retryLimit ?? 2;
	}

	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @param unitContext ログ用ユニット情報
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	async translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult> {
		// コードブロックは翻訳させずに退避する（判定はパーサーと同じ getCodeBlockLineSet）
		const { text: textWithoutCodeBlocks, codeBlocks, placeholders } = protectCodeBlocks(text);

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const primaryLang = this.primaryLang;
		const contextLang =
			primaryLang === sourceLang || primaryLang === targetLang
				? primaryLang
				: sourceLang;

		// systemPrompt（静的）と user message（可変コンテキスト＋本文）の構築
		const promptParts = this.getPromptParts(
			this.promptConfig.translatePromptId,
			{
				sourceLang,
				targetLang,
				contextLang,
				surroundingText: context.surroundingText,
				terms: context.terms,
				previousTranslation: context.previousTranslation,
				sourceDiff: context.sourceDiff,
				tmReferences: context.tmReferences,
				fileExtension: context.fileExtension,
			},
		);

		const messages: AIMessage[] = [
			{
				role: "user",
				content: buildUserMessage(promptParts, textWithoutCodeBlocks),
			},
		];

		// リトライ付きでAI呼び出し
		return await this.executeTranslationWithRetry(
			promptParts.system,
			messages,
			codeBlocks,
			placeholders,
			cancellationToken,
			unitContext,
		);
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
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionPatchResult> {
		// コードブロックは翻訳させずに退避する（判定はパーサーと同じ getCodeBlockLineSet）
		const { text: textWithoutCodeBlocks, codeBlocks, placeholders } = protectCodeBlocks(text);

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const primaryLang = this.primaryLang;
		const contextLang =
			primaryLang === sourceLang || primaryLang === targetLang
				? primaryLang
				: sourceLang;

		const promptParts = this.getPromptParts(
			this.promptConfig.revisePatchPromptId,
			{
				sourceLang,
				targetLang,
				contextLang,
				surroundingText: context.surroundingText,
				terms: context.terms,
				previousTranslation: context.previousTranslation,
				sourceDiff: context.sourceDiff,
				tmReferences: context.tmReferences,
				fileExtension: context.fileExtension,
			},
		);

		const messages: AIMessage[] = [
			{
				role: "user",
				content: buildUserMessage(promptParts, textWithoutCodeBlocks),
			},
		];

		// リトライ付きでAI呼び出し
		return await this.executeRevisionPatchWithRetry(
			promptParts.system,
			messages,
			codeBlocks,
			placeholders,
			cancellationToken,
			unitContext,
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
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult> {
		let lastError: ValidationError | undefined;
		let lastRawResponse = "";

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				throw new OperationCancelledError("Translation cancelled");
			}

			// リトライ時は補足プロンプトを user message 側に追加する
			// （system prompt を不変に保ち、プレフィックスキャッシュを維持するため）
			const retryPromptSuffix =
				attempt > 0 && lastError
					? this.buildRetryPromptSuffix(lastError, attempt)
					: "";
			const attemptMessages = retryPromptSuffix
				? this.appendToLastUserMessage(messages, retryPromptSuffix)
				: messages;

			lastRawResponse = await this.aiService.sendMessage(
				systemPrompt,
				attemptMessages,
				cancellationToken,
			);
			const validation = validateTranslationResponse(lastRawResponse);

			if (validation.valid && validation.parsed) {
				// バリデーション成功 → サニタイズ処理
				return this.processValidTranslationResponse(
					validation.parsed,
					codeBlocks,
					placeholders,
				);
			}

			lastError = validation.error;

			// リトライ不可能なエラーは即座にフォールバック
			if (!lastError?.retryable) {
				break;
			}

			// リトライ発生時のログ（初回実行の失敗はログ出力しない）
			if (attempt > 0) {
				const logger = Logger.getInstance();
				logger.warn("trans", "Translation retry", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					retryable: lastError.retryable,
					unitHash: unitContext?.unitHash,
					title: unitContext?.title,
				});
			}
		}

		// リトライ上限到達後のエラーログ
		const logger = Logger.getInstance();
		logger.error("trans", "Translation failed after all retry attempts", {
			totalAttempts: this.maxRetries + 1,
			lastError: lastError
				? formatError(lastError)
				: "No error details available",
			unitHash: unitContext?.unitHash,
			title: unitContext?.title,
		});

		// フォールバック処理
		return this.createTranslationFallbackResult(
			lastRawResponse,
			codeBlocks,
			placeholders,
			lastError,
		);
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
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionPatchResult> {
		let lastError: ValidationError | undefined;
		let lastRawResponse = "";

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				throw new OperationCancelledError("Translation cancelled");
			}

			// リトライ時は補足プロンプトを user message 側に追加する
			// （system prompt を不変に保ち、プレフィックスキャッシュを維持するため）
			const retryPromptSuffix =
				attempt > 0 && lastError
					? this.buildRetryPromptSuffix(lastError, attempt)
					: "";
			const attemptMessages = retryPromptSuffix
				? this.appendToLastUserMessage(messages, retryPromptSuffix)
				: messages;

			lastRawResponse = await this.aiService.sendMessage(
				systemPrompt,
				attemptMessages,
				cancellationToken,
			);
			const validation = validateRevisionPatchResponse(lastRawResponse);

			if (validation.valid && validation.parsed) {
				// バリデーション成功 → サニタイズ処理
				return this.processValidRevisionPatchResponse(
					validation.parsed,
					codeBlocks,
					placeholders,
				);
			}

			lastError = validation.error;

			// リトライ不可能なエラーは即座にフォールバック
			if (!lastError?.retryable) {
				break;
			}

			// リトライ発生時のログ（初回実行の失敗はログ出力しない）
			if (attempt > 0) {
				const logger = Logger.getInstance();
				logger.warn("trans", "Translation retry (revision patch)", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					retryable: lastError.retryable,
					unitHash: unitContext?.unitHash,
					title: unitContext?.title,
				});
			}
		}

		// リトライ上限到達後のエラーログ
		const logger = Logger.getInstance();
		logger.error(
			"trans",
			"Translation failed after all retry attempts (revision patch)",
			{
				totalAttempts: this.maxRetries + 1,
				lastError: lastError
					? formatError(lastError)
					: "No error details available",
				unitHash: unitContext?.unitHash,
				title: unitContext?.title,
			},
		);

		// フォールバック処理
		return this.createRevisionPatchFallbackResult(
			lastRawResponse,
			codeBlocks,
			placeholders,
			lastError,
		);
	}

	/**
	 * 有効な翻訳レスポンスを処理
	 */
	private processValidTranslationResponse(
		parsed: ParsedTranslationResponse,
		codeBlocks: string[],
		placeholders: string[],
	): TranslationResult {
		// プレースホルダー復元
		const restored = restoreCodeBlocks(
			parsed.translation,
			placeholders,
			codeBlocks,
		);

		// サニタイズ処理
		const sanitized = sanitizeTranslationOutput(restored.text);

		return {
			translatedText: sanitized.text,
			termSuggestions: parsed.termSuggestions ?? [],
			warnings: [
				...codeBlockLossWarnings(restored.missing),
				...sanitized.warnings,
				...(parsed.warnings ?? []),
			],
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
		// プレースホルダー復元
		const restored = restoreCodeBlocks(
			parsed.targetPatch,
			placeholders,
			codeBlocks,
		);

		// サニタイズ処理
		const sanitized = sanitizeTranslationOutput(restored.text);

		return {
			targetPatch: sanitized.text,
			termSuggestions: parsed.termSuggestions ?? [],
			warnings: [
				...codeBlockLossWarnings(restored.missing),
				...sanitized.warnings,
				...(parsed.warnings ?? []),
			],
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
		const restored = restoreCodeBlocks(rawResponse, placeholders, codeBlocks);

		const sanitized = sanitizeTranslationOutput(restored.text);

		return {
			translatedText: sanitized.text,
			termSuggestions: [],
			warnings: [
				`AI response format was unexpected: ${error?.message ?? "unknown error"}`,
				...codeBlockLossWarnings(restored.missing),
				...sanitized.warnings,
			],
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
		const restored = restoreCodeBlocks(rawResponse, placeholders, codeBlocks);

		const sanitized = sanitizeTranslationOutput(restored.text);

		return {
			targetPatch: sanitized.text,
			termSuggestions: [],
			warnings: [
				`AI response format was unexpected: ${error?.message ?? "unknown error"}`,
				...codeBlockLossWarnings(restored.missing),
				...sanitized.warnings,
			],
		};
	}

	/**
	 * 末尾のuserメッセージにリトライ補足を連結した新しいメッセージ配列を返す
	 */
	private appendToLastUserMessage(
		messages: AIMessage[],
		suffix: string,
	): AIMessage[] {
		if (messages.length === 0) {
			return messages;
		}
		const last = messages[messages.length - 1];
		const content = Array.isArray(last.content)
			? last.content.join("")
			: last.content;
		return [...messages.slice(0, -1), { ...last, content: content + suffix }];
	}

	/**
	 * リトライ用補足プロンプト生成
	 */
	private buildRetryPromptSuffix(
		error: ValidationError,
		attemptNumber: number,
	): string {
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Return ONLY a valid JSON object with the required fields.
- The "translation" or "targetPatch" field must contain PLAIN TEXT, not JSON.
- Do NOT nest JSON inside the translation or targetPatch field.`;
	}
}
