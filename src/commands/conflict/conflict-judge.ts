/**
 * @file conflict-judge.ts
 * @description
 *   競合の判定の AI 呼び出し層（roadmap-v04 P02）。
 *
 *   ここへ来るのは「**同じ鍵の同じ項目に、人が書いた2つの値**」だけである。片方にしか無い
 *   鍵も、触った項目が別の形も、祖先を見て片方だけが変えた形も、すべて手前の鍵の
 *   突き合わせで決定的に片付いている（`core/conflict/key-merge.ts`）。
 *
 *   AI が持ち出せる材料（TM・用語集）は人が手で集められないもので、そこがこの機能の
 *   値打ちである（集めるのは `conflict-evidence.ts`。件ごとに `<conflict>` の中へ入れる）。
 *   一方で **AI にできるのは「どちらかを選ぶ」ことだけ**で、新しい値は書けない
 *   （ADR-260911-02）。**片方が消した件は、そもそもここへ来ない** — 「消す」は AI に
 *   許した語彙の外なので、人が決める。
 *
 *   system prompt を不変に保ち、リトライは user message 側に足す（`pair-verifier.ts` と
 *   同じキャッシュ維持のやり方）。
 *
 * @module commands/conflict/conflict-judge
 */
import type * as vscode from "vscode";
import type { AIMessage, AIService } from "../../infra/llm/ai-service";
import { Logger, formatError } from "../../infra/logging/logger";
import { PromptIds } from "../../prompts";
import type { PromptId, PromptParts, PromptVariables } from "../../prompts";
import type { ConflictEvidence } from "./conflict-evidence";
import { type ConflictDecision, validateConflictResponse } from "./conflict-response-validator";
import type { ChoiceSide, PendingChoice } from "./resolution-plan";

const logger = Logger.getInstance();

/** 1回の問い合わせに載せる件数。多すぎると答えの質が落ち、少なすぎると往復が増える */
export const JUDGE_BATCH_SIZE = 10;

/** リトライの回数（形式が読めなかったときだけ。**足りなければ決めない**） */
const MAX_ATTEMPTS = 2;

/** 判定に添える材料（あるものだけ） */
export interface JudgeContext {
	/** 何が競合しているか（人が読む名前。「翻訳メモリ」「用語集」など） */
	targetName: string;
	/** AI が理由を書く言語 */
	responseLang?: string;
	/**
	 * 1件ごとの材料（用語集の抜粋・過去の近い訳）を返す係。
	 *
	 * 件ごとに違うので、まとめて1つ置くのではなく `<conflict>` の中に入れる。
	 * 材料が無ければ空を返すこと（タグそのものを出さない）。
	 */
	evidenceFor?(item: PendingChoice): ConflictEvidence;
}

/** 判定の結果 */
export interface JudgeResult {
	/** 鍵 → どちらを採るか */
	decided: Map<string, ChoiceSide>;
	/** 鍵 → なぜそちらを採るのか */
	reasons: Map<string, string>;
	/** 決まらなかった件数（AI が迷った・形式が読めなかった） */
	undecidedCount: number;
}

/** XML のタグに入れても壊れないようにする */
export function escapeForTag(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 1回の問い合わせに載せる件を、AI が読む形に組み立てる。
 *
 * 番号は**その回の中での1始まり**である。鍵をそのまま渡さないのは、鍵が長く（席のキーや
 * ハッシュ）、AI に写させると打ち間違いが混ざるからである。
 */
export function buildConflictsBlock(items: readonly PendingChoice[], context: JudgeContext): string {
	const blocks = items.map((item, i) => {
		const parts = [
			`<conflict index="${i + 1}">`,
			`<label>${escapeForTag(item.label)}</label>`,
			`<ours>${escapeForTag(item.oursText)}</ours>`,
			`<theirs>${escapeForTag(item.theirsText)}</theirs>`,
		];
		if (item.baseText !== undefined) {
			parts.push(`<base>${escapeForTag(item.baseText)}</base>`);
		}
		// 材料は件ごとに違うので、その件の中に置く。用語集も TM も外から来た文字列なので
		// 山括弧を潰してから入れる（タグの囲いを破らせない）
		const evidence = context.evidenceFor?.(item);
		if (evidence?.termsJson) {
			parts.push(`<terms>${escapeForTag(evidence.termsJson)}</terms>`);
		}
		if (evidence?.tmReferences) {
			parts.push(`<tmReferences>${escapeForTag(evidence.tmReferences)}</tmReferences>`);
		}
		parts.push("</conflict>");
		return parts.join("\n");
	});
	return ["<conflicts>", ...blocks, "</conflicts>"].join("\n");
}

/** 判定を AI に任せる係 */
export class ConflictJudge {
	constructor(
		private readonly aiService: AIService,
		private readonly getPromptParts: (id: PromptId, variables: PromptVariables) => PromptParts,
	) {}

	/**
	 * 決まらない件を AI に判定させる。
	 *
	 * **決まらなかった件は決まらないまま返す。** 迷った件・形式が読めなかった件・
	 * 問い合わせが失敗した件は、どれも人へ回る（P03）。ここで無理に片方を採らない。
	 */
	async judge(
		items: readonly PendingChoice[],
		context: JudgeContext,
		token?: vscode.CancellationToken,
	): Promise<JudgeResult> {
		const decided = new Map<string, ChoiceSide>();
		const reasons = new Map<string, string>();

		for (let offset = 0; offset < items.length; offset += JUDGE_BATCH_SIZE) {
			if (token?.isCancellationRequested) {
				break;
			}
			const batch = items.slice(offset, offset + JUDGE_BATCH_SIZE);
			const decisions = await this.judgeBatch(batch, context, token);
			for (const decision of decisions) {
				const item = batch[decision.index - 1];
				if (!item) {
					continue;
				}
				decided.set(item.key, decision.side);
				reasons.set(item.key, decision.reason);
			}
		}

		return { decided, reasons, undecidedCount: items.length - decided.size };
	}

	/** 1回ぶんの問い合わせ（形式が読めなければ1度だけ問い直す） */
	private async judgeBatch(
		batch: readonly PendingChoice[],
		context: JudgeContext,
		token?: vscode.CancellationToken,
	): Promise<ConflictDecision[]> {
		const parts = this.getPromptParts(PromptIds.CONFLICT_RESOLVE, {
			targetName: context.targetName,
			responseLang: context.responseLang,
			conflicts: buildConflictsBlock(batch, context),
		});

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (token?.isCancellationRequested) {
				return [];
			}
			// **system prompt は問い直しても変えない。** 変えるとプロバイダーの
			// プレフィックスキャッシュが外れ、問い直すたびに費用が跳ねる
			const userMessage =
				attempt === 1
					? parts.userContext
					: `${parts.userContext}\n\nRETRY INSTRUCTION: Your previous answer could not be parsed. Return ONLY the JSON object described above.`;
			const messages: AIMessage[] = [{ role: "user", content: userMessage }];

			try {
				const response = await this.aiService.sendMessage(parts.system, messages, token);
				const validated = validateConflictResponse(response, batch.length);
				if (validated.discarded.length > 0) {
					logger.info("conflict", "Discarded part of the judgement response", {
						discarded: validated.discarded.length,
						reasons: validated.discarded.slice(0, 3),
					});
				}
				if (!validated.unreadable) {
					// 応答として読めたなら、決まらなかった件は「決まらなかった」まま人へ回す。
					// 問い直すのは**まるごと読めなかったとき**だけにする — AI が答えた結果
					// （`unsure` や空の答え）を問い直しても、同じ答えが返るだけで費用が増える
					return validated.decisions;
				}
			} catch (error) {
				logger.warn("conflict", "Failed to ask for a judgement", formatError(error));
				return []; // 問い合わせそのものが失敗した。全件を人へ回す
			}
		}
		return [];
	}
}
