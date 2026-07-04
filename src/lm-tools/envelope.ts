/**
 * @file envelope.ts
 * @description
 *   LM Tools 共通の構造化出力エンベロープ。
 *   全ツールは LanguageModelTextPart にこのエンベロープの JSON 文字列を返す。
 *   エンベロープの形はエージェントとの契約であり、フィールドの削除・意味変更は
 *   TOOL_SCHEMA_VERSION のインクリメントを伴うこと（docs/design/agent-orchestration.md 参照）。
 *   VS Code API 非依存の純関数のみで構成する。
 * @module lm-tools/envelope
 */

/** 出力スキーマのバージョン。破壊的変更時にインクリメントする */
export const TOOL_SCHEMA_VERSION = 1;

/** ツール実行エラーの構造化表現 */
export interface ToolError {
	/** 機械可読なエラーコード（スネークケース） */
	code: string;
	/** 人間向けエラーメッセージ */
	message: string;
}

/** 全 LM Tools 共通の出力エンベロープ */
export interface ToolEnvelope<TData = unknown> {
	schemaVersion: number;
	/** 実行自体の成否 */
	ok: boolean;
	/** 人間向け1行サマリ（JSONを解釈しないエージェント/ユーザー向けの可読性を担保） */
	summary: string;
	/** ツール固有の構造化データ */
	data?: TData;
	/** 推奨される次アクション（ツール名＋理由）。エージェントの計画を誘導する */
	nextActions?: string[];
	/** ok:false のときのエラー詳細 */
	error?: ToolError;
}

/** よく使うエラーコード */
export const ToolErrorCode = {
	NoWorkspace: "no_workspace",
	InvalidPath: "invalid_path",
	InvalidInput: "invalid_input",
	NotTargetFile: "not_target_file",
	UserDeclined: "user_declined",
	Cancelled: "cancelled",
	InternalError: "internal_error",
} as const;

/**
 * 成功エンベロープを生成する
 */
export function createOkEnvelope<TData>(
	summary: string,
	data?: TData,
	nextActions?: string[],
): ToolEnvelope<TData> {
	const envelope: ToolEnvelope<TData> = {
		schemaVersion: TOOL_SCHEMA_VERSION,
		ok: true,
		summary,
	};
	if (data !== undefined) {
		envelope.data = data;
	}
	if (nextActions && nextActions.length > 0) {
		envelope.nextActions = nextActions;
	}
	return envelope;
}

/**
 * 失敗エンベロープを生成する
 */
export function createErrorEnvelope(
	summary: string,
	code: string,
	message: string,
	nextActions?: string[],
): ToolEnvelope<never> {
	const envelope: ToolEnvelope<never> = {
		schemaVersion: TOOL_SCHEMA_VERSION,
		ok: false,
		summary,
		error: { code, message },
	};
	if (nextActions && nextActions.length > 0) {
		envelope.nextActions = nextActions;
	}
	return envelope;
}

/**
 * エンベロープを JSON 文字列にシリアライズする。
 * Copilot Chat 上での可読性のため2スペースインデントで整形する。
 */
export function serializeEnvelope(envelope: ToolEnvelope<unknown>): string {
	return JSON.stringify(envelope, undefined, 2);
}
