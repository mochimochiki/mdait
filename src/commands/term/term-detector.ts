/**
 * @file term-detector.ts
 * @description 用語検出に特化したサービス
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import type * as vscode from "vscode";
import type { AIService } from "../../infra/llm/ai-service";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import { UnusableAIResponseError } from "../../infra/llm/unusable-response";
import { PromptIds, PromptProvider } from "../../prompts";
import { parseJsonAnswer } from "../shared/ai-json";
import { MockTermDetector } from "./mock-term-detector";
import type { TermEntry } from "./term-entry";
import { LangTerm, TermEntry as TermEntryUtils } from "./term-entry";
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
		const contextLang = primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

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
		const response = await this.aiService.sendMessage(
			systemPrompt,
			[{ role: "user", content: userPrompt }],
			cancellationToken,
		);

		if (cancellationToken?.isCancellationRequested) {
			console.log("Term detection was cancelled");
			return "";
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
		const parsed = this.parseTermArray(response);
		const usable = parsed.filter(
			(item) =>
				this.isNonEmptyString(item?.sourceTerm) &&
				this.isNonEmptyString(item?.targetTerm) &&
				this.isNonEmptyString(item?.context),
		);
		this.rejectIfNothingUsable(parsed, usable, response);

		return usable.map((item) => {
			// variantsはソース言語のみに付与（ソース言語中心）
			const languages: Record<string, LangTerm> = {
				[sourceLang]: LangTerm.create(item.sourceTerm, this.sanitizeVariants(item.variants, item.sourceTerm)),
				[targetLang]: LangTerm.create(item.targetTerm),
			};

			return TermEntryUtils.create(item.context, languages);
		});
	}

	/**
	 * ソース単独用のAI応答をパース
	 */
	private parseDetectSourceOnlyResponse(response: string, sourceLang: string): TermEntry[] {
		const parsed = this.parseTermArray(response);
		const usable = parsed.filter(
			(item) => this.isNonEmptyString(item?.sourceTerm) && this.isNonEmptyString(item?.context),
		);
		this.rejectIfNothingUsable(parsed, usable, response);

		return usable.map((item) => {
			const languages: Record<string, LangTerm> = {
				[sourceLang]: LangTerm.create(item.sourceTerm, this.sanitizeVariants(item.variants, item.sourceTerm)),
			};

			return TermEntryUtils.create(item.context, languages);
		});
	}

	/**
	 * 応答から用語の配列を取り出す。取り出せなければ**使えない答え**として断ち切る。
	 *
	 * **0件として飲み込まない。** 飲み込むと「用語が見つからなかった」と区別が付かず、
	 * 利用者には「用語集を更新しました（新しい用語 0 件）」としか伝わらない。何をしても
	 * 進まないのに、原稿のせいだと読める形で終わる（実測: 意地悪シナリオ R6-N5/N7/N8）。
	 * 正しい0件は**空の配列**（AI が「用語なし」と答えた）だけである。
	 *
	 * JSON の読み方は `commands/shared/ai-json.ts` に寄せてある（フェンス優先）。
	 */
	// biome-ignore lint/suspicious/noExplicitAny: AI の答えは形が保証されないため、項目ごとに型を見る
	private parseTermArray(response: string): any[] {
		const parsed = parseJsonAnswer(response, "Term detection");
		if (!Array.isArray(parsed)) {
			throw this.unusableResponse(response, "the JSON was not an array");
		}
		return parsed;
	}

	/** 項目は入っているのに1つも形が合わなかったなら、それは0件ではなく使えない答え */
	private rejectIfNothingUsable(parsed: readonly unknown[], usable: readonly unknown[], response: string): void {
		if (parsed.length > 0 && usable.length === 0) {
			throw this.unusableResponse(response, `none of the ${parsed.length} item(s) had the expected fields`);
		}
	}

	/** 使えない答えを表す例外を作る（message は記録用の英語。利用者向けの文は呼び出し側が組む） */
	private unusableResponse(response: string, why: string): UnusableAIResponseError {
		return new UnusableAIResponseError(
			"invalid-format",
			`Term detection response was not usable: ${why}`,
			`responseChars=${response.length}`,
		);
	}

	/**
	 * 値が空でない文字列かを判定する型ガード
	 * LLMが number など string 以外を返した場合に trim() で例外→バッチ全滅するのを防ぐ。
	 * item 自体が null/undefined でも `item?.field` 経由で安全に false になる。
	 */
	private isNonEmptyString(value: unknown): value is string {
		return typeof value === "string" && value.trim().length > 0;
	}

	/**
	 * AI応答のvariantsを整形する
	 * - 配列でなければ空配列
	 * - 文字列要素のみをtrim・空除去
	 * - 正規形（canonical）と完全一致するものを除外
	 * - 完全一致の重複を除去
	 *
	 * 照合（term-matcher の textContainsTerm）は大文字小文字を区別する部分一致のため、
	 * 大小のみ異なる表記（例: "API endpoint" と "api endpoint"）は別々に意味を持つ。
	 * よって除外・重複判定はいずれも大小を区別する（正規形そのものだけを取り除く）。
	 *
	 * @param raw AI応答のvariants値（型不明）
	 * @param canonical 正規形の用語（variantsから除外する）
	 * @returns 整形済みvariantsリスト
	 */
	private sanitizeVariants(raw: unknown, canonical: string): string[] {
		if (!Array.isArray(raw)) {
			return [];
		}

		const canonicalTrimmed = canonical.trim();
		const seen = new Set<string>();
		const result: string[] = [];

		for (const item of raw) {
			if (typeof item !== "string") {
				continue;
			}
			const trimmed = item.trim();
			if (!trimmed || trimmed === canonicalTrimmed || seen.has(trimmed)) {
				continue;
			}
			seen.add(trimmed);
			result.push(trimmed);
		}

		return result;
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
