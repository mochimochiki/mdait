/**
 * @file command-detect.ts
 * @description mdait.term.detect コマンド実装
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import * as vscode from "vscode";

import { Configuration } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { createTermDetector } from "./term-detector";
import type { TermEntry } from "./term-entry";
import { TermsRepository } from "./terms-repository";
import { TermsRepositoryCSV } from "./terms-repository-csv";

/**
 * 用語検出コマンド（mdait.term.detect）
 * 指定されたファイルから重要用語を検出し、用語集に追加
 *
 * @param uri 対象ファイルのURI
 */
export async function detectTermCommand(uri?: vscode.Uri): Promise<void> {
	const config = Configuration.getInstance();

	if (!uri) {
		vscode.window.showErrorMessage(vscode.l10n.t("No file or item selected for term detection."));
		return;
	}

	try {
		// 対象（source）ファイルの特定
		const sourceFilePath = uri.fsPath || vscode.window.activeTextEditor?.document.fileName;
		if (!sourceFilePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("No file selected for term detection."));
			return;
		}

		// ソース言語の特定
		const transPair = config.getTransPairForSourceFile(sourceFilePath);
		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("Unable to determine source language for term detection."));
			return;
		}
		const sourceLang = transPair.sourceLang;

		// Markdown ファイルの読み込みとパース
		const document = await vscode.workspace.openTextDocument(uri);
		const content = document.getText();
		const markdown = markdownParser.parse(content, config);

		// 用語検出入力データを収集
		const units = markdown.units;
		if (units.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t("No content found for term detection."));
			return;
		}

		// 用語検出処理を実行
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t("Detecting terms..."),
				cancellable: true,
			},
			async (progress, token) => {
				await detectTerm(units, sourceLang, config, progress, token);
			},
		);

		// StatusManagerのファイル状態を更新
		const statusManager = StatusManager.getInstance();
		await statusManager.refreshFileStatus(sourceFilePath);

		vscode.window.showInformationMessage(vscode.l10n.t("Term detection completed successfully."));
	} catch (error) {
		console.error("用語検出エラー:", error);
		vscode.window.showErrorMessage(
			vscode.l10n.t("Term detection failed: {0}", error instanceof Error ? error.message : String(error)),
		);
	}
}

/**
 * 用語検出処理を実行
 */
export async function detectTerm(
	units: readonly MdaitUnit[],
	sourceLang: string,
	config: Configuration,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	cancellationToken?: vscode.CancellationToken,
): Promise<void> {
	// 用語検出サービスを初期化
	const termDetector = await createTermDetector();

	// 用語集リポジトリを初期化（既存ファイルがあれば読み込み、なければ作成）
	const termsPath = config.getTermsFilePath();
	let termsRepository: TermsRepository;
	try {
		termsRepository = await TermsRepository.load(termsPath);
	} catch {
		termsRepository = await TermsRepository.create(termsPath, config.transPairs);
	}

	// 既存用語を読み込み
	const existingTerms = await termsRepository.getAllEntries();

	// primaryLang を決定（設定値があればそれを優先し、なければ sourceLang を使用）
	const configuredPrimary = config.getTermsPrimaryLang() || "";
	const primaryLang = configuredPrimary.trim() || sourceLang;

	const existingTermTexts = new Set(
		existingTerms
			.filter((entry) => entry.languages[sourceLang])
			.map((entry) => entry.languages[sourceLang].term.toLowerCase()),
	);

	const totalUnits = units.length;
	let processedCount = 0;
	const allDetectedTerms: TermEntry[] = [];

	// 各ユニットに対して用語検出を実行
	for (const unit of units) {
		// キャンセルチェック
		if (cancellationToken?.isCancellationRequested) {
			console.log("Term detection was cancelled by user");
			break;
		}

		progress.report({
			message: vscode.l10n.t("Processing section {0} of {1}", processedCount + 1, totalUnits),
			increment: 100 / totalUnits,
		});

		try {
			const detectedTerms = await termDetector.detectTerms(unit, sourceLang, existingTerms, cancellationToken);

			// 既存用語との重複を除去
			const newTerms = detectedTerms.filter((term) => {
				const termText = term.languages[sourceLang]?.term.toLowerCase();
				return termText && !existingTermTexts.has(termText);
			});

			allDetectedTerms.push(...newTerms);

			// 重複チェック用に新しい用語を追加
			for (const term of newTerms) {
				const termText = term.languages[sourceLang]?.term.toLowerCase();
				if (termText) {
					existingTermTexts.add(termText);
				}
			}
		} catch (error) {
			console.warn(`用語検出スキップ (${unit.title || "Untitled"}):`, error);
		}

		processedCount++;
	}

	// 検出された用語を用語集に追加
	if (allDetectedTerms.length > 0) {
		progress.report({
			message: vscode.l10n.t("Saving detected terms..."),
		});

		await termsRepository.Merge(allDetectedTerms, config.transPairs);
		await termsRepository.save();

		console.log(`用語検出完了: ${allDetectedTerms.length}個の新しい用語を追加しました`);
	} else {
		console.log("新しい用語は検出されませんでした");
	}
}
