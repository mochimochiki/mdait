/**
 * @file section-aligner.ts
 * @description
 *   AIアラインのAI呼び出し層。位置ベース matchResult のスケルトン＋対応表を渡し、
 *   {ok | corrections | needBodies} を審査させる。needBodies による上限付き2ラウンドの
 *   二段トリアージを AIMessage[]（assistant ロール含む多ターン）で実装する。
 *   system prompt は不変に保ち、JSON不正リトライ時は user message 末尾に RETRY INSTRUCTION を
 *   追記する（translator.ts / pair-verifier.ts と同じキャッシュ維持パターン）。ADR-260705-02。
 * @module commands/ai-sync/section-aligner
 */

import type * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import type { AIMessage, AIService } from "../../infra/llm/ai-service";
import { Logger } from "../../infra/logging/logger";
import { PromptIds, PromptProvider } from "../../prompts";
import type { PromptId, PromptParts, PromptVariables } from "../../prompts";
import type { ValidationError } from "../trans/response-validator";
import type {
	AlignCorrection,
	CorrespondenceEntry,
	NeedBodyRef,
	ParsedAlignResponse,
	UnitSkeleton,
} from "./align-result";
import { validateAlignResponse } from "./align-response-validator";

/** アライン要求 */
export interface SectionAlignRequest {
	sourceLang: string;
	targetLang: string;
	sourceSkeletons: UnitSkeleton[];
	targetSkeletons: UnitSkeleton[];
	correspondence: CorrespondenceEntry[];
	/** needBodies 応答時に参照する本文（index=配列位置） */
	sourceBodies: string[];
	targetBodies: string[];
	/** ログ用コンテキスト */
	fileContext?: string;
}

/** アライン結果（corrections は未バリデーション。fallback 時は位置ベースを使う） */
export interface SectionAlignResult {
	/** AI が提案した修正（生・未検証）。ok/fallback 時は空 */
	corrections: AlignCorrection[];
	/** 位置ベースへフォールバックすべきか（応答不正・上限超過・リトライ枯渇） */
	fallback: boolean;
	/** 実際に使用したラウンド数 */
	rounds: number;
}

/** SectionAligner の上限設定 */
export interface SectionAlignerLimits {
	/** needBodies で要求できる本文の上限件数（K） */
	maxNeedBodies: number;
	/** トリアージ上限ラウンド数（1..2） */
	maxRounds: number;
	/** JSON不正時のリトライ上限（round ごと） */
	maxRetries: number;
	/** 追加要求本文の切り詰め文字数 */
	bodyMaxLen: number;
}

const DEFAULT_LIMITS: SectionAlignerLimits = {
	maxNeedBodies: 8,
	maxRounds: 2,
	maxRetries: 2,
	bodyMaxLen: 400,
};

const logger = Logger.getInstance();

/**
 * 位置ベース対応付けを AI で差分審査するクラス。
 */
export class SectionAligner {
	private readonly aiService: AIService;
	private readonly getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts;
	private readonly limits: SectionAlignerLimits;

	constructor(
		aiService: AIService,
		getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts,
		limits: Partial<SectionAlignerLimits> = {},
	) {
		this.aiService = aiService;
		this.getPromptParts = getPromptParts;
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	/**
	 * 位置ベース matchResult を審査し、修正提案（生）を返す。
	 * needBodies → 上限付き2ラウンド。応答不正・上限超過・リトライ枯渇は fallback=true。
	 */
	async align(request: SectionAlignRequest, token?: vscode.CancellationToken): Promise<SectionAlignResult> {
		const promptParts = this.getPromptParts(PromptIds.AI_SYNC_ALIGN, {
			sourceLang: request.sourceLang,
			targetLang: request.targetLang,
			sourceSkeletons: formatSkeletons(request.sourceSkeletons),
			targetSkeletons: formatSkeletons(request.targetSkeletons),
			correspondence: formatCorrespondence(request.correspondence),
		});

		const round1User = promptParts.isLegacy
			? this.buildLegacyUserMessage(request)
			: promptParts.userContext;

		// ラウンド1
		const r1 = await this.requestRound(promptParts.system, [{ role: "user", content: round1User }], token);
		if (!r1.parsed) {
			return { corrections: [], fallback: true, rounds: 1 };
		}
		if (r1.parsed.kind === "ok") {
			return { corrections: [], fallback: false, rounds: 1 };
		}
		if (r1.parsed.kind === "corrections") {
			return { corrections: r1.parsed.corrections, fallback: false, rounds: 1 };
		}

		// needBodies: 二段トリアージ
		const refs = r1.parsed.refs;
		if (refs.length === 0) {
			return { corrections: [], fallback: false, rounds: 1 };
		}
		if (refs.length > this.limits.maxNeedBodies || this.limits.maxRounds < 2) {
			logger.info("aiSync", "Align falling back (needBodies over limit or single-round)", {
				requested: refs.length,
				maxNeedBodies: this.limits.maxNeedBodies,
				maxRounds: this.limits.maxRounds,
				file: request.fileContext,
			});
			return { corrections: [], fallback: true, rounds: 1 };
		}

		// ラウンド2（assistant ロールを含む多ターン）
		const bodyMessage = this.buildBodyMessage(refs, request);
		const round2Messages: AIMessage[] = [
			{ role: "user", content: round1User },
			{ role: "assistant", content: r1.raw },
			{ role: "user", content: bodyMessage },
		];
		const r2 = await this.requestRound(promptParts.system, round2Messages, token);
		if (!r2.parsed) {
			return { corrections: [], fallback: true, rounds: 2 };
		}
		if (r2.parsed.kind === "corrections") {
			return { corrections: r2.parsed.corrections, fallback: false, rounds: 2 };
		}
		if (r2.parsed.kind === "ok") {
			return { corrections: [], fallback: false, rounds: 2 };
		}
		// ラウンド2でも needBodies → 上限到達でフォールバック
		return { corrections: [], fallback: true, rounds: 2 };
	}

	/**
	 * 1ラウンド分の送信。JSON不正はリトライ（system 不変・last user message に RETRY 追記）。
	 * 枯渇時は parsed=null を返す。
	 */
	private async requestRound(
		system: string,
		messages: AIMessage[],
		token?: vscode.CancellationToken,
	): Promise<{ parsed: ParsedAlignResponse | null; raw: string }> {
		let lastError: ValidationError | undefined;
		let raw = "";
		for (let attempt = 0; attempt <= this.limits.maxRetries; attempt++) {
			if (token?.isCancellationRequested) {
				throw new Error("AI align cancelled");
			}
			const attemptMessages =
				attempt > 0 && lastError ? appendRetryInstruction(messages, lastError, attempt) : messages;
			raw = await this.aiService.sendMessage(system, attemptMessages, token);
			const validation = validateAlignResponse(raw);
			if (validation.valid && validation.parsed) {
				return { parsed: validation.parsed, raw };
			}
			lastError = validation.error;
			if (!lastError?.retryable) {
				break;
			}
		}
		logger.warn("aiSync", "Align response invalid after retries", {
			reason: lastError?.message,
		});
		return { parsed: null, raw };
	}

	/** needBodies に対する本文追加メッセージを組み立てる（切り詰め） */
	private buildBodyMessage(refs: NeedBodyRef[], request: SectionAlignRequest): string {
		const blocks: string[] = [];
		for (const ref of refs.slice(0, this.limits.maxNeedBodies)) {
			const skeletons = ref.side === "source" ? request.sourceSkeletons : request.targetSkeletons;
			const bodies = ref.side === "source" ? request.sourceBodies : request.targetBodies;
			if (ref.index < 0 || ref.index >= bodies.length) {
				continue;
			}
			const title = skeletons[ref.index]?.title ?? "";
			const body = truncate(bodies[ref.index], this.limits.bodyMaxLen);
			blocks.push(`[${ref.side} ${ref.index}] "${title}":\n${body}`);
		}
		return `Requested unit bodies (truncated):\n\n${blocks.join("\n---\n")}\n\nNow return your FINAL JSON verdict as {"ok": true} or {"corrections": [...]}. Do NOT request more bodies.`;
	}

	/** レガシー（user-section マーカーなし）カスタムプロンプト用の簡易 user message */
	private buildLegacyUserMessage(request: SectionAlignRequest): string {
		return [
			`Source language: ${request.sourceLang}`,
			`Target language: ${request.targetLang}`,
			"",
			"SOURCE UNITS:",
			formatSkeletons(request.sourceSkeletons),
			"",
			"TARGET UNITS:",
			formatSkeletons(request.targetSkeletons),
			"",
			"POSITION-BASED CORRESPONDENCE:",
			formatCorrespondence(request.correspondence),
			"",
			"Return ONLY the JSON verdict object.",
		].join("\n");
	}
}

/** スケルトンを1行ずつ整形する */
export function formatSkeletons(skeletons: readonly UnitSkeleton[]): string {
	return skeletons
		.map(
			(s) =>
				`[${s.index}] L${s.level} "${s.title}" (${s.length} chars)${s.locked ? " [locked]" : ""}: ${s.digest}`,
		)
		.join("\n");
}

/** 位置ベース対応表を整形する */
export function formatCorrespondence(entries: readonly CorrespondenceEntry[]): string {
	if (entries.length === 0) {
		return "(none)";
	}
	return entries
		.map((e) => `s${e.sourceIndex} <-> t${e.targetIndex}${e.locked ? " [locked]" : ""}`)
		.join("\n");
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) {
		return text;
	}
	return `${text.slice(0, maxLen)}…`;
}

/** last user message に RETRY INSTRUCTION を追記した新しい messages を返す（system 不変維持） */
function appendRetryInstruction(messages: AIMessage[], error: ValidationError, attempt: number): AIMessage[] {
	const suffix = `

RETRY INSTRUCTION (Attempt ${attempt}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Return ONLY a valid JSON object, one of:
  {"ok": true}
  {"corrections": [{"sourceIndex": 0, "targetIndex": 0, "confidence": 0.9}]}
  {"needBodies": [{"side": "source", "index": 0}]}
- "sourceIndex" / "targetIndex" must be integers referring to the skeleton indices.
- "confidence" must be a number between 0.0 and 1.0.`;
	const clone = messages.map((m) => ({ ...m }));
	for (let i = clone.length - 1; i >= 0; i--) {
		if (clone[i].role === "user" && typeof clone[i].content === "string") {
			clone[i] = { role: "user", content: `${clone[i].content as string}${suffix}` };
			break;
		}
	}
	return clone;
}

/**
 * AIService と PromptProvider から SectionAligner を構築する（buildPairVerifier と同型）。
 */
export async function buildSectionAligner(config: Configuration): Promise<SectionAligner> {
	const aiService = await new AIServiceBuilder().build(config.ai);
	const promptProvider = PromptProvider.getInstance();
	return new SectionAligner(
		aiService,
		(id, variables) => promptProvider.getPromptParts(id, variables),
		{
			maxNeedBodies: config.aiSync.align.maxNeedBodies,
			maxRounds: config.aiSync.align.maxRounds,
		},
	);
}
