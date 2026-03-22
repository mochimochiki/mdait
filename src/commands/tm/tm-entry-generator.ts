/**
 * @file tm-entry-generator.ts
 * @description
 *   LLMベースの TM登録計画生成。
 *   primary/local ユニットと既存TM情報を入力し、new/update 配列を返す。
 * @module commands/tm/tm-entry-generator
 */
import type * as vscode from "vscode";
import type { ExistingTmEntriesItem, TmCommitEntry } from "../../core/tm/types";
import type { AIMessage, AIService } from "../../llm/ai-service";
import { PromptIds, PromptProvider } from "../../prompts";
import { Logger, formatError } from "../../utils/logger";

const logger = Logger.getInstance();

export interface TmEntryGenerationRequest {
	primaryLang: string;
	localLang: string;
	/** Markdown除去済みのprimaryユニットテキスト */
	primaryUnit: string;
	/** Markdown除去済みのlocalユニットテキスト */
	localUnit: string;
	ExistingTmEntries: ExistingTmEntriesItem[];
	requiredUpdateTuids: string[];
	retryMissingTuids?: string[];
	retryReason?: string;
}

/**
 * LLMによる TM登録計画の高精度生成を行うクラス。
 */
export class LLMTmEntryGenerator {
	private readonly aiService: AIService;

	constructor(aiService: AIService) {
		this.aiService = aiService;
	}

	/**
	 * primary/local ユニットから TM登録計画を生成する。
	 * @param request TM登録計画生成要求
	 * @param cancellationToken キャンセルトークン
	 * @returns TM登録計画配列
	 */
	async generateEntries(
		request: TmEntryGenerationRequest,
		cancellationToken?: vscode.CancellationToken,
	): Promise<TmCommitEntry[]> {
		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TM_SPLIT_SENTENCES, {
			primaryLang: request.primaryLang,
			localLang: request.localLang,
			primaryUnit: request.primaryUnit,
			localUnit: request.localUnit,
			ExistingTmEntries: JSON.stringify(request.ExistingTmEntries, null, 2),
			requiredUpdateTuids: JSON.stringify(request.requiredUpdateTuids, null, 2),
			retryMissingTuids: JSON.stringify(request.retryMissingTuids ?? [], null, 2),
			retryReason: request.retryReason ?? "",
		});

		const isRetry = (request.retryMissingTuids?.length ?? 0) > 0;
		const messages: AIMessage[] = [
			{
				role: "user",
				content: isRetry
					? `Return ONLY update items for these tuids: ${request.retryMissingTuids?.join(", ")}. Focus on local completion only.`
					: `Create TM commit plan items for primary (${request.primaryLang}) and local (${request.localLang}).`,
			},
		];

		const response = await this.aiService.sendMessage(systemPrompt, messages, cancellationToken);

		return this.parseResponse(response);
	}

	/**
	 * LLMレスポンスをパースして TM登録計画配列を返す。
	 * @param response LLMからのJSON文字列レスポンス
	 * @returns パース済みの TM登録計画配列
	 */
	parseResponse(response: string): TmCommitEntry[] {
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

			const validation = this.validatePlanItems(parsed);
			if (!validation.valid) {
				logger.warn("tm.commit", "LLM alignment response failed validation", {
					reason: validation.reason,
					response: cleaned.substring(0, 200),
				});
				return [];
			}

			return validation.items;
		} catch (error) {
			logger.warn("tm.commit", "Failed to parse LLM alignment response", {
				...formatError(error),
				response: response.substring(0, 200),
			});
			return [];
		}
	}

	private validatePlanItems(
		parsed: unknown[],
	): { valid: true; items: TmCommitEntry[] } | { valid: false; reason: string } {
		const items: TmCommitEntry[] = [];

		for (let index = 0; index < parsed.length; index++) {
			const item = parsed[index];
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				return { valid: false, reason: `item ${index} must be an object` };
			}

			const record = item as Record<string, unknown>;
			const keys = Object.keys(record).sort();
			if (keys.join(",") !== "local,primary,tuid,type") {
				return { valid: false, reason: `item ${index} must contain exactly type,tuid,primary,local` };
			}

			if (record.type !== "new" && record.type !== "update") {
				return { valid: false, reason: `item ${index} has invalid type` };
			}
			if (typeof record.tuid !== "string" || typeof record.primary !== "string" || typeof record.local !== "string") {
				return { valid: false, reason: `item ${index} fields must be strings` };
			}

			const type = record.type;
			const tuid = record.tuid.trim();
			const primary = record.primary.trim();
			const local = record.local.trim();

			if (!primary || !local) {
				return { valid: false, reason: `item ${index} primary/local must not be empty` };
			}
			if (type === "new" && tuid !== "-") {
				return { valid: false, reason: `item ${index} new item must use '-' tuid` };
			}
			if (type === "update" && !tuid) {
				return { valid: false, reason: `item ${index} update item must have tuid` };
			}

			items.push({ type, tuid, primary, local });
		}

		return { valid: true, items };
	}
}
