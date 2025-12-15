/**
 * @file command-detect.ts
 * @description mdait.term.detect コマンド実装
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import * as vscode from "vscode";

import { Configuration } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { AIOnboarding } from "../../utils/ai-onboarding";
import { createTermDetector } from "./term-detector";
import type { TermEntry } from "./term-entry";
import { TermsRepository } from "./terms-repository";

/** バッチ分割の文字数閾値 */
const MAX_BATCH_CHARS = 8000;

/**
 * 用語検出コマンド（パブリックAPI）
 * MDaitUnit配列から重要用語を検出し、用語集に追加
 *
 * @param units 対象のMDaitUnit配列
 * @param sourceLang ソース言語コード
 */
export async function detectTermCommand(units: readonly MdaitUnit[], sourceLang: string): Promise<void> {
	if (units.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("No content found for term detection."));
		return;
	}

	// AI初回利用チェック
	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return; // ユーザーがキャンセルした場合
	}

	// withProgressで進捗表示とキャンセル機能を提供
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Detecting terms..."),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				await detectTermBatchInternal(units, sourceLang, progress, token);

				if (!token.isCancellationRequested) {
					vscode.window.showInformationMessage(vscode.l10n.t("Term detection completed successfully."));
				}
			} catch (error) {
				console.error("用語検出エラー:", error);
				vscode.window.showErrorMessage(
					vscode.l10n.t("Term detection failed: {0}", error instanceof Error ? error.message : String(error)),
				);
			}
		},
	);
}

/**
 * バッチ用語検出処理（内部実装）
 * expand同様のバッチ処理アーキテクチャ
 */
export async function detectTermBatchInternal(
	units: readonly MdaitUnit[],
	sourceLang: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	cancellationToken?: vscode.CancellationToken,
): Promise<void> {
	const config = Configuration.getInstance();

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
	let existingTerms = await termsRepository.getAllEntries();
	const existingTermTexts = new Set(
		existingTerms
			.filter((entry) => entry.languages[sourceLang])
			.map((entry) => entry.languages[sourceLang].term.toLowerCase()),
	);

	progress.report({ message: vscode.l10n.t("Preparing batches..."), increment: 0 });

	// Phase 1: バッチ分割
	const batches = createBatches(units);
	const totalBatches = batches.length;
	let processedBatches = 0;
	const allDetectedTerms: TermEntry[] = [];

	// Phase 2: バッチごとに用語検出
	for (const batch of batches) {
		if (cancellationToken?.isCancellationRequested) {
			console.log("Term detection was cancelled by user");
			return; // キャンセルされた
		}

		progress.report({
			message: vscode.l10n.t("Processing batch {0} of {1}", processedBatches + 1, totalBatches),
			increment: 100 / totalBatches,
		});

		try {
			// バッチ全体を1回のAI呼び出しで処理
			const detectedTerms = await termDetector.detectTermsBatch(batch, sourceLang, existingTerms, cancellationToken);

			// 既存用語との重複を除去
			const newTerms = detectedTerms.filter((term) => {
				const termText = term.languages[sourceLang]?.term.toLowerCase();
				return termText && !existingTermTexts.has(termText);
			});

			allDetectedTerms.push(...newTerms);

			// 重複チェック用に新しい用語を追加（次のバッチ検出で文脈として活用）
			for (const term of newTerms) {
				const termText = term.languages[sourceLang]?.term.toLowerCase();
				if (termText) {
					existingTermTexts.add(termText);
				}
			}

			// existingTerms配列も更新（AI呼び出し時の文脈として使用）
			if (newTerms.length > 0) {
				existingTerms = [...existingTerms, ...newTerms];
			}
		} catch (error) {
			console.warn(`Batch term detection failed:`, error);
		}

		processedBatches++;
	}

	// Phase 3: 検出された用語を用語集に追加
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

/**
 * Unit配列をバッチに分割（文字数閾値ベース）
 */
function createBatches(units: readonly MdaitUnit[]): MdaitUnit[][] {
	const batches: MdaitUnit[][] = [];
	let currentBatch: MdaitUnit[] = [];
	let currentChars = 0;

	for (const unit of units) {
		const unitChars = unit.content.length;

		// 閾値を超える場合は新しいバッチを開始
		if (currentChars + unitChars > MAX_BATCH_CHARS && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentChars = 0;
		}

		currentBatch.push(unit);
		currentChars += unitChars;
	}

	// 最後のバッチを追加
	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}
