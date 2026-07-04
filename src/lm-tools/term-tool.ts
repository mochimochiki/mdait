import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { detectTerm_CoreProc } from "../commands/term/command-detect";
import { expandTerm_CoreProc } from "../commands/term/command-expand";
import type { TermEntry } from "../commands/term/term-entry";
import { TermsRepository } from "../commands/term/terms-repository";
import { UnitPairCollector } from "../commands/term/unit-pair-collector";
import { Configuration, type TransPair } from "../infra/config/configuration";
import { Logger, formatError } from "../infra/logging/logger";
import { AIOnboarding } from "../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../infra/workspace/file-explorer";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/** detectで返す用語一覧の上限（出力爆発防止） */
const MAX_TERMS_IN_DATA = 100;

/**
 * 入力パラメータ: 用語集ツール
 */
interface TermInput {
	/** 実行するアクション */
	action: "detect" | "expand";
	/** 対象スコープ（ファイル/ディレクトリ）。省略時は全transPair */
	path?: string;
}

/** transPairごとの処理結果 */
interface TermPairResult {
	sourceLang: string;
	targetLang: string;
	/** detect: 追加された新規用語数 */
	newTerms?: number;
	/** expand: 今回展開できた用語数 */
	expanded?: number;
	/** 実行後の未展開残数（sourceLangにあってtargetLangにない用語数） */
	unexpanded: number;
}

/** mdait_term の data 形式 */
interface TermData {
	action: "detect" | "expand";
	pairs: TermPairResult[];
	/** detect: 追加された用語（先頭 MAX_TERMS_IN_DATA 件） */
	detectedTerms?: Array<{ term: string; context?: string }>;
}

/**
 * mdaitの用語集ツール（detect / expand）
 * GitHub Copilot Chatから用語検出・用語展開を実行する。
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitTermTool implements vscode.LanguageModelTool<TermInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<TermInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const { action } = options.input;
			const inputPath = options.input.path;
			logger.info("LanguageModelTool", "Term tool invoked", { action, inputPath });

			if (action !== "detect" && action !== "expand") {
				const message = vscode.l10n.t("Unknown action: {0}", String(action));
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidInput, message));
			}

			const config = Configuration.getInstance();
			const validationError = config.validate();
			if (validationError) {
				return toToolResult(
					createErrorEnvelope(validationError, ToolErrorCode.InternalError, validationError),
				);
			}

			let fileExplorer: FileExplorer;
			try {
				fileExplorer = new FileExplorer();
			} catch {
				const message = vscode.l10n.t("No workspace folder is open.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.NoWorkspace, message));
			}

			// AI初回チェック（prepareInvocationはside-effect禁止のためここで実施）
			const aiOnboarding = AIOnboarding.getInstance();
			const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
			if (!shouldProceed) {
				const message = vscode.l10n.t("Translation cancelled by user.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.UserDeclined, message));
			}

			// スコープのtransPairとソースファイル群を解決
			const scopes = await resolveTermScopes(inputPath, config, fileExplorer);
			if (scopes.length === 0) {
				const message = vscode.l10n.t("No source files found for the given scope: {0}", inputPath ?? "workspace");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			const dummyProgress: vscode.Progress<{ message?: string; increment?: number }> = {
				report: () => {
					// No-op
				},
			};

			const pairResults: TermPairResult[] = [];
			const detectedTerms: TermEntry[] = [];

			for (const scope of scopes) {
				if (token.isCancellationRequested) {
					break;
				}
				if (action === "detect") {
					const collector = new UnitPairCollector();
					const collection = await collector.collectFromFiles(scope.sourceFiles, scope.pair, token);
					const entries = await detectTerm_CoreProc(collection.pairs, scope.pair, dummyProgress, token);
					detectedTerms.push(...entries);
					pairResults.push({
						sourceLang: scope.pair.sourceLang,
						targetLang: scope.pair.targetLang,
						newTerms: entries.length,
						unexpanded: await countUnexpanded(config, scope.pair),
					});
				} else {
					const result = await expandTerm_CoreProc(
						scope.pair,
						dummyProgress,
						token,
						inputPath ? scope.sourceFiles : undefined,
					);
					pairResults.push({
						sourceLang: scope.pair.sourceLang,
						targetLang: scope.pair.targetLang,
						expanded: result.expanded,
						unexpanded: await countUnexpanded(config, scope.pair),
					});
				}
			}

			const data: TermData = { action, pairs: pairResults };
			if (action === "detect") {
				data.detectedTerms = detectedTerms.slice(0, MAX_TERMS_IN_DATA).map((entry) => {
					const langs = Object.keys(entry.languages);
					const firstTerm = langs.length > 0 ? entry.languages[langs[0]].term : "";
					return { term: firstTerm, context: entry.context || undefined };
				});
			}

			const totalNew = pairResults.reduce((sum, p) => sum + (p.newTerms ?? 0), 0);
			const totalExpanded = pairResults.reduce((sum, p) => sum + (p.expanded ?? 0), 0);
			const totalUnexpanded = pairResults.reduce((sum, p) => sum + p.unexpanded, 0);

			const summary =
				action === "detect"
					? vscode.l10n.t(
							"Term detection completed: {0} new term(s) added, {1} term(s) not yet expanded.",
							totalNew,
							totalUnexpanded,
						)
					: vscode.l10n.t(
							"Term expansion completed: {0} term(s) expanded, {1} term(s) remaining.",
							totalExpanded,
							totalUnexpanded,
						);

			const nextActions: string[] = [];
			if (totalUnexpanded > 0) {
				nextActions.push(
					`${totalUnexpanded} term(s) lack a translation in the target language. Run mdait_term with action:"expand" to expand them from existing translations.`,
				);
			} else {
				nextActions.push(
					'The glossary is fully expanded. Run mdait_term with action:"detect" again after adding content, or proceed to translation (mdait_translate) / TM commit (mdait_tm action:"commit").',
				);
			}
			return toToolResult(createOkEnvelope(summary, data, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in term tool", formatError(error));
			const errorMessage = vscode.l10n.t("Term operation failed: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<TermInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const { action } = options.input;
		const scopeLabel = options.input.path ?? vscode.l10n.t("all translation pairs");
		return {
			invocationMessage:
				action === "expand" ? vscode.l10n.t("Expanding terms...") : vscode.l10n.t("Detecting terms..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Term Operation"),
				message:
					action === "expand"
						? vscode.l10n.t(
								"Expand glossary terms for {0}? This uses AI to resolve target-language terms from existing translations and updates the terms file.",
								scopeLabel,
							)
						: vscode.l10n.t(
								"Detect glossary terms for {0}? This uses AI (batched by content size) and updates the terms file.",
								scopeLabel,
							),
			},
		};
	}
}

/** スコープ解決結果: transPairと対象ソースファイル群 */
interface TermScope {
	pair: TransPair;
	sourceFiles: string[];
}

/**
 * 入力パスからtransPairごとのソースファイル群を解決する。
 * - path省略: 全transPairの全ソースファイル
 * - pathがソースファイル/ディレクトリ: 該当するソースファイル群
 * - pathがターゲットファイル/ディレクトリ: 対応するソースファイル群に変換
 */
async function resolveTermScopes(
	inputPath: string | undefined,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<TermScope[]> {
	const scopes: TermScope[] = [];

	if (!inputPath) {
		for (const pair of config.transPairs) {
			try {
				const files = await fileExplorer.getSourceFiles(pair.sourceDir, config);
				if (files.length > 0) {
					scopes.push({ pair, sourceFiles: files });
				}
			} catch (error) {
				logger.warn("LanguageModelTool", "Failed to enumerate source files", {
					sourceDir: pair.sourceDir,
					...formatError(error),
				});
			}
		}
		return scopes;
	}

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const absPath = path.isAbsolute(inputPath)
		? inputPath
		: workspaceRoot
			? path.resolve(workspaceRoot, inputPath)
			: inputPath;
	if (!fs.existsSync(absPath)) {
		return [];
	}

	// 候補ファイルを列挙
	let candidates: string[];
	if (fs.statSync(absPath).isDirectory()) {
		const pattern = new vscode.RelativePattern(absPath, "**/*.md");
		const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
		candidates = found.map((f) => f.fsPath);
	} else {
		candidates = [absPath];
	}

	// ソースファイルへ正規化してtransPairごとにグルーピング
	const byPair = new Map<TransPair, Set<string>>();
	for (const file of candidates) {
		let sourceFile: string | null = null;
		let pair: TransPair | null = null;
		if (fileExplorer.isSourceFile(file, config)) {
			pair = config.getTransPairForSourceFile(file);
			sourceFile = file;
		} else if (fileExplorer.isTargetFile(file, config)) {
			pair = fileExplorer.getTransPairFromTarget(file, config);
			sourceFile = pair ? fileExplorer.getSourcePath(file, pair) : null;
		}
		if (pair && sourceFile && fs.existsSync(sourceFile)) {
			if (!byPair.has(pair)) {
				byPair.set(pair, new Set());
			}
			byPair.get(pair)?.add(sourceFile);
		}
	}

	for (const [pair, files] of byPair) {
		scopes.push({ pair, sourceFiles: [...files] });
	}
	return scopes;
}

/**
 * 実行後の未展開用語数（sourceLangにあってtargetLangにない）を数える。
 * terms ファイルが存在しない場合は0を返す。
 */
async function countUnexpanded(config: Configuration, pair: TransPair): Promise<number> {
	try {
		const repository = await TermsRepository.load(config.getTermsFilePath());
		const entries = await repository.getAllEntries();
		return entries.filter(
			(entry) => entry.languages[pair.sourceLang] && !entry.languages[pair.targetLang],
		).length;
	} catch {
		return 0;
	}
}
