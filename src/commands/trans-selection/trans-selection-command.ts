/**
 * @file trans-selection-command.ts
 * @description オンデマンド翻訳コマンド
 * エディタの選択範囲をmdait管理外で一時的に翻訳する軽量機能
 */

import * as vscode from "vscode";
import { AIServiceBuilder } from "../../api/ai-service-builder";
import { Configuration } from "../../config/configuration";
import { PromptIds } from "../../prompts/defaults";
import { PromptProvider } from "../../prompts/prompt-provider";
import { AIOnboarding } from "../../utils/ai-onboarding";
import { extractRelevantTerms, termsToJson } from "../trans/term-extractor";
import { TermsCacheManager } from "../trans/terms-cache-manager";
import { pickTranslationDirection } from "./direction-picker";
import type { OutputStrategy, TranslationOutput } from "./output-strategy";
import { AppendBelowStrategy } from "./strategies/append-below-strategy";

/**
 * 翻訳レスポンスの型定義
 */
interface TranslationResponse {
	translation: string;
	termSuggestions?: Array<{
		source: string;
		target: string;
		context: string;
		reason?: string;
	}>;
}

/**
 * オンデマンド翻訳コマンドのエントリーポイント
 * 選択範囲を翻訳し、指定された出力戦略で結果を適用
 */
export async function translateSelectionCommand(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		vscode.window.showErrorMessage(vscode.l10n.t("No text selected. Please select text to translate."));
		return;
	}

	const config = Configuration.getInstance();

	// AI初回利用チェック
	const aiOnboarding = AIOnboarding.getInstance();
	const shouldContinue = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldContinue) {
		return;
	}

	// 翻訳方向の決定
	const filePath = editor.document.uri.fsPath;
	const pair = await pickTranslationDirection(filePath, config);
	if (!pair) {
		return;
	}

	// 選択テキスト取得
	const sourceText = editor.document.getText(editor.selection);

	// 進捗表示付きで翻訳実行
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Translating selection..."),
			cancellable: true,
		},
		async (progress, cancellationToken) => {
			try {
				// 用語集から該当用語を抽出
				let termsJson: string | undefined;
				try {
					const termsFilePath = config.getTermsFilePath();
					const cacheManager = TermsCacheManager.getInstance();
					const allTerms = await cacheManager.getTerms(termsFilePath, config.transPairs);
					if (allTerms.length > 0) {
						const extractedTerms = extractRelevantTerms(sourceText, allTerms, pair.sourceLang, pair.targetLang);
						if (extractedTerms.length > 0) {
							termsJson = termsToJson(extractedTerms);
						}
					}
				} catch (error) {
					console.warn("Failed to extract terms for translation:", error);
					// 用語集エラーは無視して翻訳を続行
				}

				// キャンセルチェック
				if (cancellationToken.isCancellationRequested) {
					return;
				}

				progress.report({ message: vscode.l10n.t("Calling AI translation service...") });

				// AIサービス構築
				const aiServiceBuilder = new AIServiceBuilder();
				const aiService = await aiServiceBuilder.build();

				// プロンプト構築（既存のtrans.translateを再利用）
				const promptProvider = PromptProvider.getInstance();
				const prompt = promptProvider.getPrompt(PromptIds.TRANS_TRANSLATE, {
					sourceLang: pair.sourceLang,
					targetLang: pair.targetLang,
					contextLang: config.getTermsPrimaryLang(),
					terms: termsJson,
					// surroundingText、previousTranslation、sourceDiffは指定しない（オンデマンド翻訳では不要）
				});

				// キャンセルチェック
				if (cancellationToken.isCancellationRequested) {
					return;
				}

				// AI翻訳実行
				const responseText = await aiService.sendMessage(
					prompt,
					[{ role: "user", content: sourceText }],
					cancellationToken,
				);

				// キャンセルチェック
				if (cancellationToken.isCancellationRequested) {
					return;
				}

				// レスポンスパース
				const response = parseTranslationResponse(responseText);
				if (!response || !response.translation) {
					throw new Error("Invalid translation response from AI service");
				}

				progress.report({ message: vscode.l10n.t("Applying translation result...") });

				// 出力戦略適用
				const strategy = new AppendBelowStrategy();
				const output: TranslationOutput = {
					sourceText,
					translatedText: response.translation,
					sourceLang: pair.sourceLang,
					targetLang: pair.targetLang,
				};
				await strategy.apply(output, editor);

				// 成功通知
				vscode.window.showInformationMessage(
					vscode.l10n.t("Translation completed: {0} → {1}", pair.sourceLang, pair.targetLang),
				);
			} catch (error) {
				if (cancellationToken.isCancellationRequested) {
					// キャンセル時はサイレント終了
					return;
				}

				console.error("Translation failed:", error);
				vscode.window.showErrorMessage(
					vscode.l10n.t("Translation failed: {0}", error instanceof Error ? error.message : String(error)),
				);
			}
		},
	);
}

/**
 * AI翻訳レスポンスをパース
 * JSONブロック（```json）やプレーンJSONを許容
 *
 * @param responseText AI翻訳レスポンス
 * @returns パース結果（失敗時はnull）
 */
function parseTranslationResponse(responseText: string): TranslationResponse | null {
	try {
		// Markdownコードブロック形式を除去
		const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/```\s*([\s\S]*?)\s*```/);
		const jsonText = jsonMatch ? jsonMatch[1].trim() : responseText.trim();

		return JSON.parse(jsonText) as TranslationResponse;
	} catch (error) {
		console.error("Failed to parse translation response:", error);
		return null;
	}
}
