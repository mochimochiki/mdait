import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { getFileHandler } from "../commands/file-handler/file-handler-factory";
import type { DeclareIsolateResult } from "../commands/markers/declare-isolate";
import type { DeleteUnitResult } from "../commands/markers/delete-unit";
import type { KeepUnitsResult } from "../commands/markers/keep-unit";
import type { RequestTranslateSkipReason } from "../commands/markers/request-translate";
import {
	ALL_RESOLVABLE_NEEDS,
	DEFAULT_RESOLVABLE_NEEDS,
	type NeedSkipReason,
	type ResolvedNeedUnit,
	needMatchesSelection,
	unitTargets,
} from "../commands/markers/resolve-need";
import { StatusManager } from "../core/status/status-manager";
import { Logger, formatError } from "../infra/logging/logger";
import { FileExplorer } from "../infra/workspace/file-explorer";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { type NeedBreakdown, countNeedFlags, totalActionableNeeds } from "./status-data";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/** 確認UIに列挙する対象ユニットの上限 */
const MAX_CONFIRMATION_UNITS = 10;

/** 解決対象に指定できる need 種別（語彙の持ち主は resolve-need.ts） */
const ALLOWED_NEED_FILTERS = ALL_RESOLVABLE_NEEDS;

/**
 * 入力パラメータ: need フラグ解決ツール
 */
interface ResolveInput {
	/** 対象ファイルのパス（相対または絶対） */
	path: string;
	/** 対象ユニットの hash。resolve では省略時ファイル内の needs フィルタに一致する全ユニット。declare-isolate / keep / delete では必須 */
	unitHashes?: string[];
	/** 解決対象の need 種別フィルタ（action:"resolve"のみ）。省略時は ["review"] */
	needs?: string[];
	/**
	 * "resolve"（既定）: 指定 need フラグを除去する（review 等の裁定）。verify-deletion をこれで
	 * 外しても from が残るため次の sync で確認待ちが復活する — 残したい場合は "keep" を使うこと。
	 * "keep": unitHashes で指定した need:verify-deletion ユニットを独立ユニットとして残す
	 * （need と from を同時に外す恒久化。ツリー/CodeLens の Keep と同じ）。
	 * "declare-isolate": unitHashes で指定したユニットに need:isolate を宣言する（凍結。伝播停止）。
	 * 既に need が付いているユニットは宣言をスキップする（他の判断待ちを踏み潰さない安全弁）。
	 * "delete": unitHashes で指定した need:verify-deletion ユニットをドキュメントから削除する。
	 * 安全弁として need:verify-deletion 以外のユニットは削除・独立化できない。
	 * "request-translate": unitHashes で指定した need:review ユニットを採用せず、翻訳待ち
	 * （need:translate）へ戻す。印を付け替えるだけで AI は呼ばない（CodeLens「要翻訳にする」と同じ。
	 * ADR-260912-07）。review 以外のユニットは変えない。
	 */
	action?: "resolve" | "keep" | "declare-isolate" | "delete" | "request-translate";
}

/** 受け付ける action。ここに無い値は入力の誤りとして弾く */
const ALLOWED_ACTIONS: readonly string[] = ["resolve", "keep", "declare-isolate", "delete", "request-translate"];

/** mdait_resolve の data 形式（action:"resolve"） */
interface ResolveData {
	file: string;
	resolved: ResolvedNeedUnit[];
	skipped: Array<{ hash: string; reason: NeedSkipReason }>;
	/** 解決後にファイル内へ残っている need 内訳 */
	remainingNeeds: NeedBreakdown;
}

/** mdait_resolve の data 形式（action:"declare-isolate"） */
interface DeclareIsolateData {
	file: string;
	declared: Array<{ hash: string; title?: string }>;
	skipped: Array<{
		hash: string;
		reason: NonNullable<DeclareIsolateResult["reason"]>;
	}>;
}

/** mdait_resolve の data 形式（action:"keep"） */
interface KeepUnitData {
	file: string;
	kept: Array<{ hash: string; title?: string }>;
	skipped: KeepUnitsResult["skipped"];
}

/** mdait_resolve の data 形式（action:"delete"） */
interface DeleteUnitData {
	file: string;
	deleted: Array<{ hash: string; title?: string }>;
	skipped: Array<{
		hash: string;
		reason: NonNullable<DeleteUnitResult["reason"]>;
	}>;
}

/** mdait_resolve の data 形式（action:"request-translate"） */
interface RequestTranslateData {
	file: string;
	requested: Array<{ hash: string; title?: string }>;
	skipped: Array<{ hash: string; reason: RequestTranslateSkipReason }>;
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
				targets: unitTargets(options.input.unitHashes),
				needs: options.input.needs,
				action: options.input.action,
			});

			if (!inputPath) {
				const message = vscode.l10n.t("No path specified for need resolution.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

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

			const action = options.input.action ?? "resolve";
			// **知らない action を「解決」として扱わない。** 既定値は省略したときだけで、綴りを誤った
			// action まで既定の resolve に落ちると、確かめる前の訳を承認してしまう（受け入れテストで実測）
			if (!ALLOWED_ACTIONS.includes(action)) {
				const message = vscode.l10n.t(
					'Unknown action: "{0}". Use one of: {1}.',
					String(action),
					ALLOWED_ACTIONS.join(", "),
				);
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidInput, message));
			}
			const unitHashes = options.input.unitHashes ?? [];
			if (action !== "resolve" && unitHashes.length === 0) {
				// 省略してファイル内全件へ暗黙に効かせる経路は作らない（意図せぬ一括操作の安全弁。
				// 複数の hash を明示した一括操作はできる）
				const message = vscode.l10n.t(
					'unitHashes is required for action:"{0}". Run mdait_getStatus (detail:true) to find target unit hashes.',
					action,
				);
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidInput, message));
			}
			if (action === "declare-isolate") {
				return await this.invokeDeclareIsolate(inputPath, absPath, unitHashes);
			}
			if (action === "keep") {
				return await this.invokeKeep(inputPath, absPath, unitHashes);
			}
			if (action === "delete") {
				return await this.invokeDelete(inputPath, absPath, unitHashes);
			}
			if (action === "request-translate") {
				return await this.invokeRequestTranslate(inputPath, absPath, unitHashes);
			}

			// needs フィルタの語彙チェック（未知の値はエージェントの入力ミスとして弾く）
			const needsFilter = options.input.needs;
			if (needsFilter) {
				const invalid = needsFilter.filter((n) => !ALLOWED_NEED_FILTERS.includes(n));
				if (invalid.length > 0) {
					const message = vscode.l10n.t(
						"Unknown need kind(s) in needs filter: {0}. Allowed values: {1}.",
						invalid.join(", "),
						ALLOWED_NEED_FILTERS.join(", "),
					);
					return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidInput, message));
				}
			}

			const result = await getFileHandler(absPath).resolveNeed(absPath, {
				targets: unitTargets(options.input.unitHashes),
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
			return toToolResult(createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message));
		}
	}

	/** action:"declare-isolate" の実処理 */
	private async invokeDeclareIsolate(
		inputPath: string,
		absPath: string,
		unitHashes: string[],
	): Promise<vscode.LanguageModelToolResult> {
		const declared: Array<{ hash: string; title?: string }> = [];
		const skipped: Array<{
			hash: string;
			reason: NonNullable<DeclareIsolateResult["reason"]>;
		}> = [];
		for (const hash of unitHashes) {
			const result = await getFileHandler(absPath).declareIsolate(absPath, {
				kind: "unit",
				hash,
			});
			if (result.declared) {
				declared.push(result.title ? { hash: result.hash, title: result.title } : { hash: result.hash });
			} else {
				skipped.push({
					hash: result.hash,
					reason: result.reason ?? "not-found",
				});
			}
		}

		const data: DeclareIsolateData = { file: inputPath, declared, skipped };
		const summary = vscode.l10n.t(
			"Declared need:isolate on {0} unit(s) in {1} ({2} skipped).",
			declared.length,
			inputPath,
			skipped.length,
		);

		const nextActions: string[] = [];
		if (skipped.some((s) => s.reason === "need-already-set")) {
			nextActions.push(
				"Some units already had a pending need and were skipped. Resolve that need first (mdait_resolve) if you still intend to isolate them, then retry.",
			);
		}
		if (skipped.some((s) => s.reason === "not-found")) {
			nextActions.push(
				"Some unit hashes were not found. Run mdait_getStatus (detail:true) to get current unit hashes, then retry.",
			);
		}
		if (declared.length > 0) {
			nextActions.push(
				'Isolated units are frozen: sync will keep their hash/from in sync but stop propagating revise. Run mdait_resolve (needs:["isolate"]) with the same unitHashes to undeclare later if needed.',
			);
		}
		if (nextActions.length === 0) {
			nextActions.push("Nothing was declared. Run mdait_getStatus (detail:true) to inspect unit state.");
		}

		return toToolResult(createOkEnvelope(summary, data, nextActions));
	}

	/**
	 * action:"keep" の実処理。
	 * need:verify-deletion 以外のユニットは独立化しない（keepUnits の安全弁）。
	 */
	private async invokeKeep(
		inputPath: string,
		absPath: string,
		unitHashes: string[],
	): Promise<vscode.LanguageModelToolResult> {
		const result = await getFileHandler(absPath).keepUnits(absPath, unitHashes);
		const data: KeepUnitData = { file: inputPath, kept: result.kept, skipped: result.skipped };
		const summary = vscode.l10n.t(
			"Kept {0} unit(s) as independent in {1} ({2} skipped).",
			result.kept.length,
			inputPath,
			result.skipped.length,
		);

		const nextActions: string[] = [];
		if (result.skipped.some((s) => s.reason === "not-verify-deletion")) {
			nextActions.push(
				"Some units were skipped because they don't have need:verify-deletion. Only units awaiting deletion review can be kept this way.",
			);
		}
		if (result.skipped.some((s) => s.reason === "not-found")) {
			nextActions.push(
				"Some unit hashes were not found. Run mdait_getStatus (detail:true) to get current unit hashes, then retry.",
			);
		}
		if (result.kept.length > 0) {
			nextActions.push(
				"Kept units are now independent: sync will no longer match them against the source. If the source section ever comes back, a fresh translation unit will be created alongside them.",
			);
		}
		if (nextActions.length === 0) {
			nextActions.push("Nothing was kept. Run mdait_getStatus (detail:true) to inspect unit state.");
		}

		return toToolResult(createOkEnvelope(summary, data, nextActions));
	}

	/**
	 * action:"delete" の実処理。
	 * need:verify-deletion 以外のユニットは削除しない（deleteUnitFromFile の安全弁）。
	 */
	private async invokeDelete(
		inputPath: string,
		absPath: string,
		unitHashes: string[],
	): Promise<vscode.LanguageModelToolResult> {
		const deleted: Array<{ hash: string; title?: string }> = [];
		const skipped: Array<{
			hash: string;
			reason: NonNullable<DeleteUnitResult["reason"]>;
		}> = [];
		for (const hash of unitHashes) {
			const result = await getFileHandler(absPath).deleteUnit(absPath, {
				kind: "unit",
				hash,
			});
			if (result.deleted) {
				deleted.push(result.title ? { hash: result.hash, title: result.title } : { hash: result.hash });
			} else {
				skipped.push({
					hash: result.hash,
					reason: result.reason ?? "not-found",
				});
			}
		}

		const data: DeleteUnitData = { file: inputPath, deleted, skipped };
		const summary = vscode.l10n.t(
			"Deleted {0} unit(s) from {1} ({2} skipped).",
			deleted.length,
			inputPath,
			skipped.length,
		);

		const nextActions: string[] = [];
		if (skipped.some((s) => s.reason === "not-verify-deletion")) {
			nextActions.push(
				"Some units were skipped because they don't have need:verify-deletion. Only units flagged for deletion review can be deleted this way.",
			);
		}
		if (skipped.some((s) => s.reason === "not-found")) {
			nextActions.push(
				"Some unit hashes were not found. Run mdait_getStatus (detail:true) to get current unit hashes, then retry.",
			);
		}
		if (deleted.length === 0 && nextActions.length === 0) {
			nextActions.push("Nothing was deleted. Run mdait_getStatus (detail:true) to inspect unit state.");
		}

		return toToolResult(createOkEnvelope(summary, data, nextActions));
	}

	/**
	 * action:"request-translate" の実処理。確認待ちの既訳を採用せず、翻訳待ちへ戻す。
	 * 印を付け替えるだけで AI は呼ばない。need:review 以外のユニットは変えない
	 * （訳し終えた本文や他の判断待ちを黙って翻訳待ちに戻さない）。
	 */
	private async invokeRequestTranslate(
		inputPath: string,
		absPath: string,
		unitHashes: string[],
	): Promise<vscode.LanguageModelToolResult> {
		const requested: RequestTranslateData["requested"] = [];
		const skipped: RequestTranslateData["skipped"] = [];
		for (const hash of unitHashes) {
			const result = await getFileHandler(absPath).requestTranslate(absPath, { kind: "unit", hash });
			if (result.requested) {
				requested.push(result.title ? { hash: result.hash, title: result.title } : { hash: result.hash });
			} else {
				skipped.push({ hash, reason: result.reason ?? "not-found" });
			}
		}

		const data: RequestTranslateData = { file: inputPath, requested, skipped };
		const summary = vscode.l10n.t(
			"Sent {0} unit(s) in {1} back to translation ({2} skipped).",
			requested.length,
			inputPath,
			skipped.length,
		);

		const nextActions: string[] = [];
		if (skipped.some((s) => s.reason === "not-review")) {
			nextActions.push(
				"Some units were skipped because they don't have need:review. Only units awaiting review can be sent back to translation this way.",
			);
		}
		if (skipped.some((s) => s.reason === "not-found")) {
			nextActions.push(
				"Some unit hashes were not found. Run mdait_getStatus (detail:true) to get current unit hashes, then retry.",
			);
		}
		if (requested.length > 0) {
			nextActions.push(
				"The units now have need:translate and keep their current text until translated. Run mdait_translate on this file to translate them (uses AI).",
			);
		}
		if (nextActions.length === 0) {
			nextActions.push("Nothing was sent back. Run mdait_getStatus (detail:true) to inspect unit state.");
		}

		return toToolResult(createOkEnvelope(summary, data, nextActions));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ResolveInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const inputPath = options.input.path ?? "";

		if (options.input.action !== undefined && !ALLOWED_ACTIONS.includes(options.input.action)) {
			// invoke が入力の誤りとして弾くので、何かを書き換えるかのような確認は出さない
			return { invocationMessage: vscode.l10n.t("Resolving need flags...") };
		}

		if (options.input.action === "declare-isolate") {
			const hashes = options.input.unitHashes ?? [];
			return {
				invocationMessage: vscode.l10n.t("Declaring need:isolate..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm Isolate Declaration"),
					message: vscode.l10n.t(
						"This will declare need:isolate on {0} unit(s) in {1}, freezing them so sync stops propagating revise. Units that already have a pending need are skipped. No AI is used.",
						hashes.length,
						inputPath,
					),
				},
			};
		}

		if (options.input.action === "keep") {
			const hashes = options.input.unitHashes ?? [];
			return {
				invocationMessage: vscode.l10n.t("Keeping unit(s) as independent..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm Keep as Independent"),
					message: vscode.l10n.t(
						"This will keep {0} unit(s) flagged need:verify-deletion in {1} as independent units. They will no longer be matched against the source; re-linking them later is a manual edit. No AI is used.",
						hashes.length,
						inputPath,
					),
				},
			};
		}

		if (options.input.action === "request-translate") {
			const targets = collectConfirmationTargets(resolveInputPath(inputPath), options.input.unitHashes, ["review"]);
			return {
				invocationMessage: vscode.l10n.t("Sending unit(s) back to translation..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm Sending Back to Translation"),
					message: vscode.l10n.t(
						"This will reject the current translation of {0} unit(s) flagged need:review in {1} and mark them need:translate. Their text stays until they are translated. No AI is used.{2}",
						targets.length,
						inputPath,
						formatUnitList(targets),
					),
				},
			};
		}

		if (options.input.action === "delete") {
			// **本文を消す操作こそ、何を消すのかを並べる。** 件数だけを出していたので、
			// いちばん重い操作の確認がいちばん情報の少ない確認になっていた
			// （無害な resolve は見出しつきで列挙していたのに、である）
			const targets = collectConfirmationTargets(resolveInputPath(inputPath), options.input.unitHashes, [
				"verify-deletion",
			]);
			return {
				invocationMessage: vscode.l10n.t("Deleting unit(s)..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm Unit Deletion"),
					message: vscode.l10n.t(
						"This will permanently remove {0} unit(s) flagged need:verify-deletion from {1}. This cannot be undone by mdait — recover via git history if needed. No AI is used.{2}",
						targets.length,
						inputPath,
						formatUnitList(targets),
					),
				},
			};
		}

		// マーカー書換（AI不使用）のため、対象ユニットを列挙して確認を求める
		const targets = collectConfirmationTargets(
			resolveInputPath(inputPath),
			options.input.unitHashes,
			options.input.needs,
		);

		const unitList = formatUnitList(targets);

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

/** 確認UI用: 対象ユニットを「hash・need・見出し」の箇条書きにする（多すぎるときは省略） */
function formatUnitList(targets: ReadonlyArray<{ hash: string; title?: string; need: string }>): string {
	const lines = targets
		.slice(0, MAX_CONFIRMATION_UNITS)
		.map((t) => (t.title ? `- ${t.hash} need:${t.need} "${t.title}"` : `- ${t.hash} need:${t.need}`));
	if (targets.length > MAX_CONFIRMATION_UNITS) {
		lines.push(vscode.l10n.t("...and {0} more unit(s)", targets.length - MAX_CONFIRMATION_UNITS));
	}
	return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
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
		targets.push({
			hash: unit.unitHash,
			title: unit.title,
			need: unit.needFlag,
		});
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
	if (remaining.review > 0) {
		nextActions.push(
			`${remaining.review} unit(s) in this file still have need:review. Review them and run mdait_resolve again with their unitHashes to approve.`,
		);
	}
	if (remaining.verifyDeletion > 0) {
		nextActions.push(
			`${remaining.verifyDeletion} unit(s) in this file still have need:verify-deletion. Decide per unit: run mdait_resolve (action:"keep") to keep them as independent units, or (action:"delete") to remove them.`,
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
