import * as vscode from "vscode";
import {
	type ValidateCheck,
	type ValidationReport,
	validate_CoreProc,
} from "../commands/validate/validate-command";
import { Logger, formatError } from "../infra/logging/logger";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: 検証ツール
 */
interface ValidateInput {
	/** 対象スコープ（ファイル/ディレクトリ）。省略時は全transPair */
	path?: string;
	/** 実行する検証種別。省略時は両方 */
	checks?: ValidateCheck[];
}

/**
 * mdaitの検証ツール（構造チェック＋用語一貫性 term-lint）
 * 読取専用・AI不使用・確認UIなし。エージェントがループ内で何度呼んでも副作用ゼロ。
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitValidateTool implements vscode.LanguageModelTool<ValidateInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ValidateInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const inputPath = options.input.path;
			const requested = options.input.checks;
			const checks: ValidateCheck[] =
				requested && requested.length > 0
					? requested.filter((c): c is ValidateCheck => c === "structure" || c === "terms")
					: ["structure", "terms"];
			if (checks.length === 0) {
				const message = vscode.l10n.t("No valid checks specified. Use \"structure\" and/or \"terms\".");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			logger.info("LanguageModelTool", "Validate tool invoked", { inputPath, checks });

			const report: ValidationReport = await validate_CoreProc(inputPath, checks);

			const structureCount = report.violations.filter((v) => v.check === "structure").length;
			const termsCount = report.violations.filter((v) => v.check === "terms").length;
			const summary = vscode.l10n.t(
				"Validation completed: {0} violation(s) ({1} structure, {2} terms) across {3} file(s), {4} translated unit(s) checked, {5} unit(s) skipped (need flags remain).",
				report.violations.length,
				structureCount,
				termsCount,
				report.filesChecked,
				report.unitsChecked,
				report.unitsSkipped,
			);

			const nextActions: string[] = [];
			if (termsCount > 0) {
				nextActions.push(
					"For each terms violation, choose one: (a) the translation deviates from the glossary — fix the target unit text (re-translate or edit) so it uses the expected term; or (b) the deviation is a legitimate synonym — add it to the term's variants in the terms file so future lint passes accept it. Do not blindly rewrite; judge per violation.",
				);
			}
			if (structureCount > 0) {
				nextActions.push(
					"Structure violations indicate the translation's Markdown structure (headings/lists/code blocks/links) differs from the source. Inspect each unit and fix the target content, then re-run mdait_validate.",
				);
			}
			if (report.unitsSkipped > 0) {
				nextActions.push(
					`${report.unitsSkipped} unit(s) still have need flags and were not validated. Run mdait_translate / resolve reviews first, then re-run mdait_validate.`,
				);
			}
			if (nextActions.length === 0) {
				nextActions.push(
					"No violations. Validation is read-only and free — re-run it after any translation pass to keep the loop closed.",
				);
			}

			return toToolResult(createOkEnvelope(summary, report, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in validate tool", formatError(error));
			const errorMessage = vscode.l10n.t("Validation failed: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
		}
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<ValidateInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		// 読取専用・AI不使用のため確認不要
		return {
			invocationMessage: vscode.l10n.t("Validating translations..."),
		};
	}
}
