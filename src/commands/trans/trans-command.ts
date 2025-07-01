import * as fs from "node:fs"; // @important Node.jsのbuildinモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { StatusCollector } from "../../core/status/status-collector";
import { StatusManager } from "../../core/status/status-manager";
import { TranslationContext } from "./translation-context";
import type { Translator } from "./translator";
import { TranslatorBuilder } from "./translator-builder";

export async function transCommand(uri?: vscode.Uri) {
	const statusManager = StatusManager.getInstance();

	try {
		// ファイルパスの取得
		const targetFilePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
		if (!targetFilePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
			return;
		}
		// 設定の読み込み
		const config = new Configuration();
		await config.load();

		// 翻訳ペアから言語情報を取得
		const transPair = config.getTransPairForTargetFile(targetFilePath);
		if (!transPair) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("No translation pair found for file: {0}", targetFilePath),
			);
			return;
		}

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

		// 各ユニットを翻訳
		for (const unit of unitsToTranslate) {
			// 翻訳開始をStatusManagerに通知
			if (unit.marker?.hash) {
				statusManager.updateUnitStatus(unit.marker.hash, { isTranslating: true });
			}

			try {
				await translateUnit(unit, translator, sourceLang, targetLang, markdown);

				// 翻訳完了をStatusManagerに通知
				if (unit.marker?.hash) {
					statusManager.updateUnitStatus(unit.marker.hash, {
						status: "translated",
						needFlag: undefined,
						isTranslating: false,
					});
				}
			} catch (error) {
				// 翻訳エラーをStatusManagerに通知
				if (unit.marker?.hash) {
					statusManager.updateUnitStatus(unit.marker.hash, {
						status: "error",
						isTranslating: false,
						errorMessage: (error as Error).message,
					});
				}
				throw error;
			}
		}

		// 更新されたMarkdownを保存
		const updatedContent = markdownParser.stringify(markdown);
		await fs.promises.writeFile(targetFilePath, updatedContent, "utf-8");

		// ファイル全体の状態をStatusManagerで更新
		await statusManager.updateFileStatus(targetFilePath);

		// インデックスファイル更新は廃止（StatusItemベースの管理に移行）
		console.log("Translation completed - StatusItem based management");
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("Error during translation: {0}", (error as Error).message),
		);
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

	try {
		// 翻訳コンテキストの作成
		const context = new TranslationContext();
		// TODO: context に surroundingText や glossary を設定するロジックを実装

		let sourceContent = unit.content;

		// from属性がある場合は、StatusManagerベースで翻訳元ユニットのコンテンツを取得
		if (unit.marker?.from) {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				const sourceUnits = statusManager.findUnitsByFromHash(unit.marker.from);
				if (sourceUnits.length > 0) {
					// 最初に見つかった翻訳元ユニットを使用
					const sourceUnit = sourceUnits[0];
					try {
						if (sourceUnit.filePath) {
							const config = new Configuration();
							await config.load();
							const sourceFileContent = await fs.promises.readFile(sourceUnit.filePath, "utf-8");
							const sourceMarkdown = markdownParser.parse(sourceFileContent, config);
							// unitHashでユニットを特定
							const sourceUnitData = sourceMarkdown.units.find(
								(u) => u.marker?.hash === sourceUnit.unitHash,
							);
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
		const translatedContent = await translator.translate(
			sourceContent,
			sourceLang,
			targetLang,
			context,
		);
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
		vscode.window.showErrorMessage(
			vscode.l10n.t("Unit translation error: {0}", (error as Error).message),
		);
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

	try {
		// 設定の読み込み
		const config = new Configuration();
		await config.load();

		// 翻訳ペアから言語情報を取得
		const transPair = config.getTransPairForTargetFile(filePath);
		if (!transPair) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("No translation pair found for file: {0}", filePath),
			);
			return;
		}

		const sourceLang = transPair.sourceLang;
		const targetLang = transPair.targetLang;
		const translator = await new TranslatorBuilder().build();

		// Markdown ファイルの読み込みとパース
		const markdownContent = await fs.promises.readFile(filePath, "utf-8");
		const markdown = markdownParser.parse(markdownContent, config);

		// 指定されたハッシュのユニットを検索
		const targetUnit = findUnitByHash(markdown.units, unitHash);
		if (!targetUnit) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("Unit with hash {0} not found in file {1}", unitHash, filePath),
			);
			return;
		}

		// ユニットが翻訳必要かチェック
		if (!targetUnit.needsTranslation()) {
			vscode.window.showInformationMessage(
				vscode.l10n.t("Unit {0} does not need translation", unitHash),
			);
			return;
		}

		// 翻訳開始をStatusManagerに通知
		statusManager.updateUnitStatus(unitHash, { isTranslating: true });

		try {
			await translateUnit(targetUnit, translator, sourceLang, targetLang, markdown);

			// 翻訳完了をStatusManagerに通知
			statusManager.updateUnitStatus(unitHash, {
				status: "translated",
				needFlag: undefined,
				isTranslating: false,
			});
		} catch (error) {
			// 翻訳エラーをStatusManagerに通知
			statusManager.updateUnitStatus(unitHash, {
				status: "error",
				isTranslating: false,
				errorMessage: (error as Error).message,
			});
			throw error;
		}

		// 更新されたMarkdownを保存
		const updatedContent = markdownParser.stringify(markdown);
		await fs.promises.writeFile(filePath, updatedContent, "utf-8");

		// ファイル全体の状態をStatusManagerで更新
		await statusManager.updateFileStatus(filePath);

		vscode.window.showInformationMessage(
			vscode.l10n.t("Unit translation completed: {0}", unitHash),
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("Error during unit translation: {0}", (error as Error).message),
		);
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
