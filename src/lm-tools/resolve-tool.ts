import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import {
	DEFAULT_RESOLVABLE_NEEDS,
	needMatchesSelection,
	resolveNeedForFile,
	type NeedSkipReason,
	type ResolvedNeedUnit,
} from "../commands/markers/resolve-need";
import { StatusManager } from "../core/status/status-manager";
import { Configuration } from "../infra/config/configuration";
import { Logger, formatError } from "../infra/logging/logger";
import { FileExplorer } from "../infra/workspace/file-explorer";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { type NeedBreakdown, countNeedFlags, totalActionableNeeds } from "./status-data";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/** 確認UIに列挙する対象ユニットの上限 */
const MAX_CONFIRMATION_UNITS = 10;

/** needs フィルタとして受理する値（マーカーの既定 need 語彙） */
const ALLOWED_NEED_FILTERS = ["review", "verify-deletion", "translate", "revise", "isolate"] as const;

/**
 * 入力パラメータ: need フラグ解決ツール
 */
interface ResolveInput {
	/** 対象ファイルのパス（相対または絶対） */
	path: string;
	/** 対象ユニットの hash。省略時はファイル内の needs フィルタに一致する全ユニット */
	unitHashes?: string[];
	/** 解決対象の need 種別フィルタ。省略時は ["review", "verify-deletion"] */
	needs?: string[];
}

/** mdait_resolve の data 形式 */
interface ResolveData {
	file: string;
	resolved: ResolvedNeedUnit[];
	skipped: Array<{ hash: string; reason: NeedSkipReason }>;
	/** 解決後にファイル内へ残っている need 内訳 */
	remainingNeeds: NeedBreakdown;
}

/**
 * mdaitのneedフラグ解決ツール
 * need:review / need:verify-deletion 等の解決（フラグ除去）を GitHub Copilot Chat から
 * プログラム的に行う。CodeLens「Mark as Reviewed」（mdait.codelens.clearNeed）のLM Tool版。
 * マーカーの hash / from / 本文は変更しない。AI不使用だがマーカーを書き換えるため確認UIあり。
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitResolveTool implements vscode.LanguageModelTool<ResolveInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ResolveInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const inputPath = options.input.path;
			logger.info("LanguageModelTool", "Resolve tool invoked", {
				inputPath,
				unitHashes: options.input.unitHashes,
				needs: options.input.needs,
			});

			if (!inputPath) {
				const message = vscode.l10n.t("No path specified for need resolution.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			const config = Configuration.getInstance();
			try {
				new FileExplorer();
			} catch {
				const message = vscode.l10n.t("No workspace folder is open.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.NoWorkspace, message));
			}

			const absPath = resolveInputPath(inputPath);
			if (!fs.existsSync(absPath)) {
				const message = vscode.l10n.t("Path not found: {0}", inputPath);
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}
			if (fs.statSync(absPath).isDirectory()) {
				const message = vscode.l10n.t("Path must be a file, not a directory: {0}", inputPath);
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.InvalidPath, message, [
						"Run mdait_getStatus (detail:true) on the directory to find files with need flags, then call mdait_resolve per file.",
					]),
				);
			}

			// needs フィルタの語彙チェック（未知の値はエージェントの入力ミスとして弾く）
			const needsFilter = options.input.needs;
			if (needsFilter) {
				const invalid = needsFilter.filter(
					(n) => !(ALLOWED_NEED_FILTERS as readonly string[]).includes(n),
				);
				if (invalid.length > 0) {
					const message = vscode.l10n.t(
						"Unknown need kind(s) in needs filter: {0}. Allowed values: {1}.",
						invalid.join(", "),
						ALLOWED_NEED_FILTERS.join(", "),
					);
					return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidInput, message));
				}
			}

			const result = await resolveNeedForFile(absPath, config, {
				unitHashes: options.input.unitHashes,
				needs: needsFilter,
			});

			const remainingNeeds = countNeedFlags(result.remainingNeedFlags);
			const data: ResolveData = {
				file: inputPath,
				resolved: result.resolved,
				skipped: result.skipped,
				remainingNeeds,
			};

			const summary = vscode.l10n.t(
				"Resolved {0} need flag(s) in {1} ({2} skipped). {3} need flag(s) remain in the file.",
				result.resolved.length,
				inputPath,
				result.skipped.length,
				result.remainingNeedFlags.length,
			);

			return toToolResult(createOkEnvelope(summary, data, buildResolveNextActions(data)));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in resolve tool", formatError(error));
			const errorMessage = vscode.l10n.t("Failed to resolve need flags: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ResolveInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		// マーカー書換（AI不使用）のため、対象ユニットを列挙して確認を求める
		const inputPath = options.input.path ?? "";
		const targets = collectConfirmationTargets(
			resolveInputPath(inputPath),
			options.input.unitHashes,
			options.input.needs,
		);

		const lines = targets.slice(0, MAX_CONFIRMATION_UNITS).map((t) => {
			return t.title ? `- ${t.hash} need:${t.need} "${t.title}"` : `- ${t.hash} need:${t.need}`;
		});
		if (targets.length > MAX_CONFIRMATION_UNITS) {
			lines.push(vscode.l10n.t("...and {0} more unit(s)", targets.length - MAX_CONFIRMATION_UNITS));
		}
		const unitList = lines.length > 0 ? `\n\n${lines.join("\n")}` : "";

		return {
			invocationMessage: vscode.l10n.t("Resolving need flags..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Need Flag Resolution"),
				message: vscode.l10n.t(
					"This will remove {0} need flag(s) from unit markers in {1}. Marker hashes and from links are not changed, and no AI is used.{2}",
					targets.length,
					inputPath,
					unitList,
				),
			},
		};
	}
}

/** 確認UI用: ステータスツリーから解決対象になるユニットを列挙する */
function collectConfirmationTargets(
	absPath: string,
	unitHashes?: string[],
	needs?: string[],
): Array<{ hash: string; title?: string; need: string }> {
	const selected = needs && needs.length > 0 ? needs : DEFAULT_RESOLVABLE_NEEDS;
	const fileItem = StatusManager.getInstance().getStatusItemTree().getFile(absPath);
	const units = fileItem?.children ?? [];
	const targets: Array<{ hash: string; title?: string; need: string }> = [];
	for (const unit of units) {
		if (!unit.needFlag || !needMatchesSelection(unit.needFlag, selected)) {
			continue;
		}
		if (unitHashes && unitHashes.length > 0 && !unitHashes.includes(unit.unitHash)) {
			continue;
		}
		targets.push({ hash: unit.unitHash, title: unit.title, need: unit.needFlag });
	}
	return targets;
}

/**
 * 解決結果に応じたエージェント向け次アクションを生成する。
 */
function buildResolveNextActions(data: ResolveData): string[] {
	const nextActions: string[] = [];
	const notFound = data.skipped.filter((s) => s.reason === "not-found").length;
	if (notFound > 0) {
		nextActions.push(
			`${notFound} unit hash(es) were not found in the file. Run mdait_getStatus (detail:true) to get the current unit hashes, then retry mdait_resolve.`,
		);
	}
	const remaining = data.remainingNeeds;
	if (remaining.review + remaining.verifyDeletion > 0) {
		nextActions.push(
			`${remaining.review + remaining.verifyDeletion} unit(s) in this file still have need:review or need:verify-deletion. Review them and run mdait_resolve again with their unitHashes to approve.`,
		);
	}
	if (remaining.translate + remaining.revise > 0) {
		nextActions.push(
			`${remaining.translate + remaining.revise} unit(s) in this file still need translation/revision. Run mdait_translate to process them (do not resolve these flags unless you intend to skip translation).`,
		);
	}
	if (data.resolved.length > 0 && totalActionableNeeds(remaining) === 0) {
		nextActions.push(
			'All need flags in this file are resolved. Run mdait_tm (action:"commit") to register the approved translations into the translation memory, or mdait_getStatus to check the remaining workspace state.',
		);
	}
	if (nextActions.length === 0) {
		nextActions.push(
			"Nothing was resolved. Run mdait_getStatus (detail:true) to inspect which units have need flags and their hashes.",
		);
	}
	return nextActions;
}

/**
 * 入力パスを絶対パスへ解決する
 */
function resolveInputPath(inputPath: string): string {
	if (path.isAbsolute(inputPath)) {
		return inputPath;
	}
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return workspaceRoot ? path.resolve(workspaceRoot, inputPath) : inputPath;
}
