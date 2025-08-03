/**
 * @file trans-command.ts
 * @description
 *   VSCode拡張機能用のMarkdown翻訳コマンドを提供するモジュール。
 *   - ファイル全体またはユニット単位での翻訳処理を実装。
 *   - 翻訳対象ファイルの検出、翻訳ペアの判定、翻訳サービスの呼び出し、状態管理(StatusManager)との連携を行う。
 *   - Markdownユニットのパース・更新・保存、翻訳進捗やエラーの通知も含む。
 * @module commands/trans/trans-command
 */
import * as fs from "node:fs"; // @important Node.jsのbuildinモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { StatusCollector } from "../../core/status/status-collector";
import { Status } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { FileExplorer } from "../../utils/file-explorer";
import { TranslationContext } from "./translation-context";
import type { Translator } from "./translator";
import { TranslatorBuilder } from "./translator-builder";

/**
 * Markdownファイルの翻訳コマンドを実行する
 * @param uri 翻訳対象ファイルのURI（ファイルパス）
 */
export async function transCommand(uri?: vscode.Uri) {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	try {
		// ファイルパスの取得
		const targetFilePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
		if (!targetFilePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
			return;
		}

		// ファイル探索クラスを初期化
		const fileExplorer = new FileExplorer();

		// 翻訳ペアから言語情報を取得
		const classification = fileExplorer.classifyFile(targetFilePath, config);
		if (classification.type !== "target" || !classification.transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for file: {0}", targetFilePath));
			return;
		}

		const transPair = classification.transPair;
		const sourceLang = transPair.sourceLang;
		const targetLang = transPair.targetLang;
		const translator = await new TranslatorBuilder().build();
		// Markdown ファイルの読み込みとパース
		const markdownContent = await fs.promises.readFile(targetFilePath, "utf-8");
		const markdown = markdownParser.parse(markdownContent, config);

		// need:translate フラグを持つユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());
		if (unitsToTranslate.length === 0) {
			return;
		}

		// ファイルステータスをInProgressに
		await statusManager.changeFileStatus(targetFilePath, { isTranslating: true });

		// 各ユニットを翻訳
		for (const unit of unitsToTranslate) {
			// 翻訳開始をStatusManagerに通知
			if (unit.marker?.hash) {
				statusManager.changeUnitStatus(unit.marker.hash, { isTranslating: true }, targetFilePath);
			}

			try {
				await translateUnit(unit, translator, sourceLang, targetLang, markdown);
			} catch (error) {
				// 翻訳エラーをStatusManagerに通知
				if (unit.marker?.hash) {
					statusManager.changeUnitStatus(
						unit.marker.hash,
						{
							status: Status.Error,
							isTranslating: false,
							errorMessage: (error as Error).message,
						},
						targetFilePath,
					);
				}
				throw error;
			}
		}

		// 更新されたMarkdownを保存
		const updatedContent = markdownParser.stringify(markdown);
		await fs.promises.writeFile(targetFilePath, updatedContent, "utf-8");

		// ファイル全体の状態をStatusManagerで更新
		await statusManager.refreshFileStatus(targetFilePath);

		console.log(`Translation completed - ${path.basename(targetFilePath)}`);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Error during translation: {0}", (error as Error).message));
	}
}

/**
 * 単一ユニットの翻訳処理
 * @param unit 翻訳対象のユニット
 * @param translator 翻訳サービス
 * @param sourceLang 翻訳元言語
 * @param targetLang 翻訳先言語
 * @param markdown Markdownドキュメント（翻訳元ユニット特定用）
 */
async function translateUnit(
	unit: MdaitUnit,
	translator: Translator,
	sourceLang: string,
	targetLang: string,
	markdown: Markdown,
) {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	try {
		// 翻訳コンテキストの作成
		const context = new TranslationContext();
		// TODO: context に surroundingText や glossary を設定するロジックを実装

		let sourceContent = unit.content;

		// from属性がある場合は、StatusManagerベースで翻訳元ユニットのコンテンツを取得
		if (unit.marker?.from) {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				const sourceUnit = statusManager.getUnitStatusItemByFromHash(unit.marker.from);
				if (sourceUnit) {
					try {
						if (sourceUnit.filePath) {
							const sourceFileContent = await fs.promises.readFile(sourceUnit.filePath, "utf-8");
							const sourceMarkdown = markdownParser.parse(sourceFileContent, config);
							// unitHashでユニットを特定
							const sourceUnitData = sourceMarkdown.units.find((u) => u.marker?.hash === sourceUnit.unitHash);
							if (sourceUnitData) {
								sourceContent = sourceUnitData.content;
							}
						}
					} catch (error) {
						console.warn(`Failed to read source unit from ${sourceUnit.filePath}:`, error);
					}
				} else {
					console.warn(`Source unit not found for hash: ${unit.marker.from}`);
				}
			}
		}
		// 翻訳実行
		const translatedContent = await translator.translate(sourceContent, sourceLang, targetLang, context);
		// ユニットのコンテンツを更新
		unit.content = translatedContent;

		// ハッシュを再計算してmarkerを更新
		if (unit.marker) {
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;
		}

		// needフラグを除去
		unit.markAsTranslated();
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Unit translation error: {0}", (error as Error).message));
		throw error;
	}
}

/**
 * 単一ユニットの翻訳を実行する
 * @param filePath 対象ファイルのパス
 * @param unitHash 翻訳対象のユニットハッシュ
 */
export async function transUnitCommand(filePath: string, unitHash: string) {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	try {
		// ファイル探索クラスを初期化
		const fileExplorer = new FileExplorer();

		// 翻訳ペアから言語情報を取得
		const classification = fileExplorer.classifyFile(filePath, config);
		if (classification.type !== "target" || !classification.transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for file: {0}", filePath));
			return;
		}

		const transPair = classification.transPair;

		const sourceLang = transPair.sourceLang;
		const targetLang = transPair.targetLang;
		const translator = await new TranslatorBuilder().build();

		// Markdown ファイルの読み込みとパース
		const markdownContent = await fs.promises.readFile(filePath, "utf-8");
		const markdown = markdownParser.parse(markdownContent, config);

		// 指定されたハッシュのユニットを検索
		const targetUnit = findUnitByHash(markdown.units, unitHash);
		if (!targetUnit) {
			vscode.window.showErrorMessage(vscode.l10n.t("Unit with hash {0} not found in file {1}", unitHash, filePath));
			return;
		}

		// ユニットが翻訳必要かチェック
		if (!targetUnit.needsTranslation()) {
			vscode.window.showInformationMessage(vscode.l10n.t("Unit {0} does not need translation", unitHash));
			return;
		}

		// 翻訳開始をStatusManagerに通知
		statusManager.changeUnitStatus(unitHash, { isTranslating: true }, filePath);

		try {
			await translateUnit(targetUnit, translator, sourceLang, targetLang, markdown);

			// 翻訳完了をStatusManagerに通知
			statusManager.changeUnitStatus(
				unitHash,
				{
					status: Status.Translated,
					needFlag: undefined,
					isTranslating: false,
					unitHash: targetUnit.marker.hash,
				},
				filePath,
			);
		} catch (error) {
			// 翻訳エラーをStatusManagerに通知
			statusManager.changeUnitStatus(
				unitHash,
				{
					status: Status.Error,
					isTranslating: false,
					errorMessage: (error as Error).message,
				},
				filePath,
			);
			throw error;
		}

		// 更新されたMarkdownを保存
		const updatedContent = markdownParser.stringify(markdown);
		await fs.promises.writeFile(filePath, updatedContent, "utf-8");

		// ファイル全体の状態をStatusManagerで更新
		await statusManager.refreshFileStatus(filePath);

		vscode.window.showInformationMessage(vscode.l10n.t("Unit translation completed: {0}", unitHash));
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Error during unit translation: {0}", (error as Error).message));
	}
}

/**
 * ハッシュでユニットを検索
 * @param units ユニット配列
 * @param hash 検索対象のハッシュ
 * @returns 見つかったユニット（なければnull）
 */
function findUnitByHash(units: MdaitUnit[], hash: string): MdaitUnit | null {
	return units.find((unit) => unit.marker?.hash === hash) || null;
}
