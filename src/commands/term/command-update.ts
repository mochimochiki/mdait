/**
 * @file command-update.ts
 * @description
 *   「✨用語集を更新」（`mdait.term.update`）— 用語の検出と展開を1操作にまとめる。
 *
 *   以前は `term.detect`（原文から用語を拾う）と `term.expand`（訳語を埋める）が
 *   別コマンドで、しかも原文行と翻訳完了行に分かれて出ていた。「検出」「展開」は
 *   用語集が2段階で作られるという**実装都合の語彙**であり、利用者が知る必要はない
 *   （ADR-260802-02）。ここでは確認1回・AI同意1回・進捗1本・通知1本にまとめる。
 * @module commands/term/command-update
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { type StatusItem, StatusItemType } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { Configuration, type TransPair } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { OperationRegistry } from "../shared/operation-registry";
import { notifyWithReport } from "../shared/report-file";
import { detectTerm_CoreProc } from "./command-detect";
import { expandTerm_CoreProc } from "./command-expand";
import { writeTermReport } from "./term-report-file";
import { UnitPairCollector } from "./unit-pair-collector";

const logger = Logger.getInstance();

/** 用語集更新の対象（原文ファイル群と、それが属する翻訳ペア） */
interface GlossaryScope {
	sourceFiles: string[];
	transPair: TransPair;
	/** 確認ダイアログに出すスコープ名（ワークスペース相対） */
	label: string;
}

/**
 * ツリーアイテムから用語集更新の対象を解決する。
 *
 * 原文側の行からも訳文側の行からも同じ操作を出すため、どちらで押されても
 * 「原文ファイル群 + 翻訳ペア」へ正規化する（訳文側で押されたら対応する原文を引く）。
 */
async function resolveScope(item: StatusItem): Promise<GlossaryScope | undefined> {
	const config = Configuration.getInstance();
	const fileExplorer = new FileExplorer();
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const toLabel = (p: string) => path.relative(workspaceRoot, p).replace(/\\/g, "/") || path.basename(p);

	const collectMarkdown = async (dir: string): Promise<string[]> => {
		const pattern = new vscode.RelativePattern(dir, "**/*.md");
		const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
		return found.map((f) => f.fsPath);
	};

	/** 訳文パス群を原文パス群へ写像する（対応が取れないものは落とす） */
	const toSourceFiles = (targetFiles: string[]): { files: string[]; pair?: TransPair } => {
		const files: string[] = [];
		let pair: TransPair | undefined;
		for (const target of targetFiles) {
			const found = fileExplorer.getTransPairFromTarget(target, config);
			if (!found) {
				continue;
			}
			const source = fileExplorer.getSourcePath(target, found);
			if (source) {
				files.push(source);
				pair ??= found;
			}
		}
		return { files, pair };
	};

	if (item.type === StatusItemType.Directory && item.directoryPath) {
		const dir = item.directoryPath;
		const all = await collectMarkdown(dir);
		const sources = all.filter((f) => fileExplorer.isSourceFile(f, config));
		if (sources.length > 0) {
			const transPair = config.getTransPairForSourceFile(sources[0]);
			return transPair ? { sourceFiles: sources, transPair, label: toLabel(dir) } : undefined;
		}
		const { files, pair } = toSourceFiles(all.filter((f) => fileExplorer.isTargetFile(f, config)));
		return pair && files.length > 0 ? { sourceFiles: files, transPair: pair, label: toLabel(dir) } : undefined;
	}

	if (item.type === StatusItemType.File && item.filePath) {
		const file = item.filePath;
		if (fileExplorer.isSourceFile(file, config)) {
			const transPair = config.getTransPairForSourceFile(file);
			return transPair ? { sourceFiles: [file], transPair, label: toLabel(file) } : undefined;
		}
		const { files, pair } = toSourceFiles([file]);
		return pair && files.length > 0 ? { sourceFiles: files, transPair: pair, label: toLabel(file) } : undefined;
	}

	return undefined;
}

/**
 * 用語集を更新する（検出 → 展開を続けて実行）。
 *
 * StatusTree の原文行・訳文行のどちらからでも呼べる。
 */
export async function updateGlossaryCommand(item?: StatusItem): Promise<void> {
	if (!item) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return;
	}

	const scope = await resolveScope(item);
	if (!scope) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("No source documents found here. The glossary is built from the source language."),
		);
		return;
	}

	// 確認は1回だけ（対象件数を出す。UX-P4）
	const yes = vscode.l10n.t("Yes");
	const confirmation = await vscode.window.showInformationMessage(
		vscode.l10n.t(
			"Update the glossary from '{0}'? ({1} file(s), {2} → {3})",
			scope.label,
			scope.sourceFiles.length,
			scope.transPair.sourceLang,
			scope.transPair.targetLang,
		),
		{ modal: true },
		yes,
		vscode.l10n.t("No"),
	);
	if (confirmation !== yes) {
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	if (!(await aiOnboarding.checkAndShowFirstUseDialog())) {
		return;
	}

	const statusManager = StatusManager.getInstance();
	// 処理中はツリーにスピナーを出す。実体は実行台帳への登録で、解除は finally の
	// release() 一経路だけが行う（StatusItem に旗を持たせない・ADR-260803-01）
	const handles = scope.sourceFiles
		.map((file) => OperationRegistry.getInstance().acquire({ kind: "terms", scope: "file", path: file }))
		.filter((h): h is NonNullable<typeof h> => h !== undefined);
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Updating glossary ({0} → {1})", scope.transPair.sourceLang, scope.transPair.targetLang),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				// 1. 原文から用語を拾う
				progress.report({ message: vscode.l10n.t("Collecting unit pairs..."), increment: 0 });
				const collection = await new UnitPairCollector().collectFromFiles(scope.sourceFiles, scope.transPair, token);
				const detected =
					collection.pairs.length === 0
						? []
						: await detectTerm_CoreProc(collection.pairs, scope.transPair, progress, token);
				if (token.isCancellationRequested) {
					return;
				}

				// 2. 訳語が空の用語を埋める
				const expanded = await expandTerm_CoreProc(scope.transPair, progress, token, scope.sourceFiles);
				if (token.isCancellationRequested) {
					return;
				}

				const uri =
					detected.length > 0
						? await writeTermReport({
								entries: detected,
								sourceLang: scope.transPair.sourceLang,
								targetLang: scope.transPair.targetLang,
							})
						: undefined;
				notifyWithReport(
					vscode.l10n.t(
						"Glossary updated: {0} new term(s), {1} translation(s) filled in, {2} still missing.",
						detected.length,
						expanded.expanded,
						expanded.remaining,
					),
					uri,
				);
			} catch (error) {
				logger.error("term.update", "Glossary update failed", { ...formatError(error) });
				vscode.window.showErrorMessage(
					vscode.l10n.t("Error while updating the glossary: {0}", (error as Error).message),
				);
			} finally {
				// スピナーの解除と再集計は、成功・失敗・キャンセルのどれでも必ず行う
				for (const handle of handles) {
					handle.release();
				}
				for (const file of scope.sourceFiles) {
					await statusManager.refreshFileStatus(file);
				}
			}
		},
	);
}
