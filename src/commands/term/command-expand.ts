/**
 * @file command-expand.ts
 * @description mdait.term.expand コマンド実装
 * 検出済み用語を対象言語に展開する
 */

import * as vscode from "vscode";

import { Configuration, type TransPair } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { FileExplorer } from "../../utils/file-explorer";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";
import { type TermExpansionContext, createTermExpander } from "./term-expander";
import { TermsRepository } from "./terms-repository";

/** バッチ分割の文字数閾値 */
const MAX_BATCH_CHARS = 8000;

/**
 * 用語展開コマンド（パブリックAPI）
 * 検出済み用語を指定されたターゲット言語に展開
 *
 * @param item ステータスツリーアイテム（ターゲット言語のルートディレクトリ）
 */
export async function expandTermCommand(item?: StatusItem): Promise<void> {
	const config = Configuration.getInstance();

	if (!item) {
		vscode.window.showErrorMessage(vscode.l10n.t("No target directory selected for term expansion."));
		return;
	}

	// ターゲットディレクトリの情報を取得
	if (item.type !== "directory" || !item.directoryPath) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
		return;
	}

	const targetDir = item.directoryPath;
	const transPair = config.getTransPairForTargetFile(targetDir);

	if (!transPair) {
		vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for target: {0}", targetDir));
		return;
	}

	// withProgressで進捗表示とキャンセル機能を提供
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Expanding terms ({0} → {1})", transPair.sourceLang, transPair.targetLang),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				await expandTermsInternal(transPair, progress, token);

				if (!token.isCancellationRequested) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("Term expansion completed ({0} → {1})", transPair.sourceLang, transPair.targetLang),
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : vscode.l10n.t("Unknown error during term expansion");
				vscode.window.showErrorMessage(vscode.l10n.t("Error during term expansion: {0}", message));
			}
		},
	);
}

/**
 * 用語展開処理（内部実装）
 */
export async function expandTermsInternal(
	transPair: TransPair,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	cancellationToken: vscode.CancellationToken,
): Promise<void> {
	const config = Configuration.getInstance();
	const { sourceDir, targetDir, sourceLang, targetLang } = transPair;

	// 用語集リポジトリを読み込み
	const termsPath = config.getTermsFilePath();
	let termsRepository: TermsRepository;
	try {
		termsRepository = await TermsRepository.load(termsPath);
	} catch {
		// 用語集が存在しない場合はエラー
		throw new Error(vscode.l10n.t("Terms file not found. Please run term detection first."));
	}

	// 既存用語を取得
	const allTerms = await termsRepository.getAllEntries();

	// 未展開の用語を抽出（sourceLangは存在するがtargetLangが存在しない）
	const termsToExpand = allTerms.filter((entry) => {
		return entry.languages[sourceLang] && !entry.languages[targetLang];
	});

	if (termsToExpand.length === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("All terms are already expanded for {0} → {1}", sourceLang, targetLang),
		);
		return;
	}

	progress.report({ message: vscode.l10n.t("Scanning source files..."), increment: 0 });

	// Phase 0: 用語を含むファイルの事前フィルタリング
	const filesToProcess = await phase0_FilterFilesContainingTerms(transPair, termsToExpand, cancellationToken);

	if (cancellationToken.isCancellationRequested) {
		return;
	}

	// Phase 1: 用語展開コンテキストの収集
	const contexts = await phase1_CollectExpansionContexts(
		transPair,
		termsToExpand,
		filesToProcess,
		progress,
		cancellationToken,
	);

	if (cancellationToken.isCancellationRequested) {
		return;
	}

	// Phase 2: グローバルバッチ分割と一括抽出
	const phase2Results = await phase2_ExtractFromBatches(transPair, contexts, progress, cancellationToken);

	if (cancellationToken.isCancellationRequested) {
		return;
	}

	// Phase 2で解決できなかった用語を抽出
	const unresolvedTerms = termsToExpand.filter((entry) => {
		const sourceTerm = entry.languages[sourceLang].term;
		return !phase2Results.has(sourceTerm);
	});

	// Phase 3: 未解決用語をAI翻訳
	const phase3Results = await phase3_TranslateUnresolvedTerms(unresolvedTerms, transPair, progress, cancellationToken);

	// 用語集を更新
	const allResults = new Map([...phase2Results, ...phase3Results]);

	if (allResults.size === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("No terms could be expanded"));
		return;
	}

	// 用語エントリを更新
	const updatedTerms: TermEntry[] = termsToExpand
		.map((entry) => {
			const sourceTerm = entry.languages[sourceLang].term;
			const targetTerm = allResults.get(sourceTerm);

			if (targetTerm) {
				const newLanguages = {
					...entry.languages,
					[targetLang]: { term: targetTerm, variants: [] as readonly string[] },
				};
				return TermEntryUtils.create(entry.context, newLanguages);
			}
			return entry;
		})
		.filter((entry) => entry.languages[targetLang]);

	// マージして保存
	progress.report({ message: vscode.l10n.t("Saving terms...") });
	await termsRepository.Merge(updatedTerms, config.transPairs);
	await termsRepository.save();

	progress.report({ increment: 20 });
}

/**
 * Phase 1: 用語展開コンテキストの収集
 * 全ファイルをパースしてUnitペアと関連用語を紐付ける
 */
async function phase1_CollectExpansionContexts(
	transPair: TransPair,
	termsToExpand: readonly TermEntry[],
	filesToProcess: Set<string>,
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
	cancellationToken?: vscode.CancellationToken,
): Promise<TermExpansionContext[]> {
	progress?.report({ message: vscode.l10n.t("Phase 1: Collecting translation contexts..."), increment: 0 });

	const contexts: TermExpansionContext[] = [];
	const { sourceLang, targetLang } = transPair;
	const config = Configuration.getInstance();
	const fileExplorer = new FileExplorer();
	const processedUnitPairs = new Set<string>();
	const collectedTerms = new Set<string>();

	for (const sourceFilePath of filesToProcess) {
		if (cancellationToken?.isCancellationRequested) {
			break;
		}

		try {
			const sourceDoc = await vscode.workspace.openTextDocument(sourceFilePath);
			const sourceMarkdown = markdownParser.parse(sourceDoc.getText(), config);

			const targetFilePath = fileExplorer.getTargetPath(sourceFilePath, transPair);
			if (!targetFilePath) {
				continue;
			}

			let targetDoc: vscode.TextDocument;
			try {
				targetDoc = await vscode.workspace.openTextDocument(targetFilePath);
			} catch {
				continue;
			}

			const targetMarkdown = markdownParser.parse(targetDoc.getText(), config);

			for (const sourceUnit of sourceMarkdown.units) {
				if (cancellationToken?.isCancellationRequested) {
					break;
				}

				const sourceHash = sourceUnit.marker?.hash;
				if (!sourceHash) {
					continue;
				}

				const targetUnit = findTargetUnit(targetMarkdown.units, sourceHash);
				if (!targetUnit) {
					continue;
				}

				const unitPairKey = `${sourceHash}#${targetUnit.marker?.hash}`;
				if (processedUnitPairs.has(unitPairKey)) {
					continue;
				}
				processedUnitPairs.add(unitPairKey);

				const relevantTerms = termsToExpand.filter((term) => {
					const termText = term.languages[sourceLang]?.term;
					return termText && !collectedTerms.has(termText) && sourceUnit.content.includes(termText);
				});

				if (relevantTerms.length > 0) {
					contexts.push({
						sourceUnit,
						targetUnit,
						terms: relevantTerms,
					});

					for (const term of relevantTerms) {
						const termText = term.languages[sourceLang]?.term;
						if (termText) {
							collectedTerms.add(termText);
						}
					}
				}
			}
		} catch (error) {
			console.error(`Failed to process file: ${sourceFilePath}`, error);
		}
	}

	progress?.report({
		message: vscode.l10n.t(
			"Phase 1 completed: {0} contexts collected, {1} unique terms",
			contexts.length,
			collectedTerms.size,
		),
		increment: 10,
	});

	return contexts;
}

/**
 * Phase 2: グローバルバッチ分割と一括抽出
 */
async function phase2_ExtractFromBatches(
	transPair: TransPair,
	contexts: TermExpansionContext[],
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
	cancellationToken?: vscode.CancellationToken,
): Promise<Map<string, string>> {
	progress?.report({ message: vscode.l10n.t("Phase 2: Extracting terms from translations..."), increment: 0 });

	const results = new Map<string, string>();
	const { sourceLang, targetLang } = transPair;

	if (contexts.length === 0) {
		progress?.report({
			message: vscode.l10n.t("Phase 2 completed: {0} terms resolved", 0),
			increment: 50,
		});
		return results;
	}

	const batches = splitIntoBatches(contexts);
	const termExpander = await createTermExpander();

	for (const batch of batches) {
		if (cancellationToken?.isCancellationRequested) {
			break;
		}

		const optimizedBatch = batch
			.map((ctx) => ({
				...ctx,
				terms: ctx.terms.filter((term) => {
					const termText = term.languages[sourceLang]?.term;
					return termText && !results.has(termText);
				}),
			}))
			.filter((ctx) => ctx.terms.length > 0);

		if (optimizedBatch.length === 0) {
			continue;
		}

		const extracted = await termExpander.extractFromTranslationsBatch(
			optimizedBatch,
			sourceLang,
			targetLang,
			cancellationToken,
		);

		for (const [source, target] of extracted) {
			results.set(source, target);
		}

		progress?.report({
			message: vscode.l10n.t("Phase 2: {0} terms resolved", results.size),
		});
	}

	progress?.report({
		message: vscode.l10n.t("Phase 2 completed: {0} terms resolved", results.size),
		increment: 50,
	});

	return results;
}

/**
 * Phase 3: 未解決用語をAI翻訳
 */
async function phase3_TranslateUnresolvedTerms(
	unresolvedTerms: readonly TermEntry[],
	transPair: TransPair,
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
	cancellationToken?: vscode.CancellationToken,
): Promise<Map<string, string>> {
	const results = new Map<string, string>();
	const { sourceLang, targetLang } = transPair;

	if (unresolvedTerms.length === 0) {
		progress?.report({
			message: vscode.l10n.t("Phase 3 completed: {0} terms translated", 0),
			increment: 20,
		});
		return results;
	}

	if (cancellationToken?.isCancellationRequested) {
		return results;
	}

	progress?.report({ message: vscode.l10n.t("Phase 3: Translating remaining terms...") });

	const termExpander = await createTermExpander();
	const translated = await termExpander.translateTerms(unresolvedTerms, sourceLang, targetLang, cancellationToken);

	for (const [source, target] of translated) {
		results.set(source, target);
	}

	progress?.report({
		message: vscode.l10n.t("Phase 3 completed: {0} terms translated", results.size),
		increment: 20,
	});

	return results;
}

/**
 * グローバルバッチ分割
 * 文字数閾値でコンテキストをバッチに分割
 */
function splitIntoBatches(contexts: TermExpansionContext[]): TermExpansionContext[][] {
	const batches: TermExpansionContext[][] = [];
	let currentBatch: TermExpansionContext[] = [];
	let currentCharCount = 0;

	for (const context of contexts) {
		const contextSize = context.sourceUnit.content.length + context.targetUnit.content.length;

		if (currentCharCount + contextSize > MAX_BATCH_CHARS && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentCharCount = 0;
		}

		currentBatch.push(context);
		currentCharCount += contextSize;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

/**
 * Phase 0: 用語を含むファイルの事前フィルタリング
 */
async function phase0_FilterFilesContainingTerms(
	transPair: TransPair,
	terms: readonly TermEntry[],
	cancellationToken?: vscode.CancellationToken,
): Promise<Set<string>> {
	// StatusItemTree からソースファイルリストを取得
	const statusManager = StatusManager.getInstance();
	const tree = statusManager.getStatusItemTree();
	const allSourceFiles = tree.getSourceFilesAll();

	// 用語リストを構築
	const termList = terms
		.filter((entry) => entry.languages[transPair.sourceLang])
		.map((entry) => entry.languages[transPair.sourceLang].term);

	if (termList.length === 0) {
		return new Set();
	}

	// フィルタ済みファイルを収集
	const filePaths = new Set<string>();

	try {
		// バッチサイズを定義（並列処理の単位）
		const BATCH_SIZE = 20;

		// バッチごとに並列処理
		for (let i = 0; i < allSourceFiles.length; i += BATCH_SIZE) {
			if (cancellationToken?.isCancellationRequested) {
				break;
			}

			const batch = allSourceFiles.slice(i, i + BATCH_SIZE);

			await Promise.all(
				batch.map(async (sourceFile) => {
					if (!sourceFile.filePath) {
						return;
					}

					try {
						const doc = await vscode.workspace.openTextDocument(sourceFile.filePath);
						const content = doc.getText();

						// いずれかの用語が含まれているか確認
						if (termList.some((term) => content.includes(term))) {
							filePaths.add(sourceFile.filePath);
						}
					} catch (error) {
						// ファイル読み込みエラーはスキップ
						console.error(`Failed to read file: ${sourceFile.filePath}`, error);
					}
				}),
			);
		}
	} catch (error) {
		console.error("Phase 0 filtering failed, processing all files:", error);
		// フィルタリング失敗時は全ファイルを対象
		return new Set(allSourceFiles.map((f) => f.filePath).filter((p): p is string => p !== undefined));
	}

	return filePaths;
}

/**
 * fromHashで対応するターゲットUnitを検索
 */
function findTargetUnit(targetUnits: readonly MdaitUnit[], sourceHash: string): MdaitUnit | undefined {
	return targetUnits.find((unit) => unit.marker?.from === sourceHash);
}
