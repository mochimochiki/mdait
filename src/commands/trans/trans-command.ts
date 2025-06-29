import * as fs from "node:fs"; // @important Node.jsのbuildinモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import {
	findUnitsByFromHash,
	loadIndexFile,
	updateIndexForFile,
} from "../../core/index/index-manager";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { TranslationContext } from "./translation-context";
import type { Translator } from "./translator";
import { TranslatorBuilder } from "./translator-builder";

export async function transCommand(uri?: vscode.Uri) {
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
			await translateUnit(unit, translator, sourceLang, targetLang, markdown);
		}

		// 更新されたMarkdownを保存
		const updatedContent = markdownParser.stringify(markdown);
		await fs.promises.writeFile(targetFilePath, updatedContent, "utf-8");

		// インデックスファイルを更新（翻訳によりneedFlagが変更されたため）
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			const updateSuccess = await updateIndexForFile(workspaceRoot, targetFilePath, config);
			if (!updateSuccess) {
				console.warn("Failed to update index file after translation");
			}
		}
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
	try {
		// 翻訳コンテキストの作成
		const context = new TranslationContext();
		// TODO: context に surroundingText や glossary を設定するロジックを実装

		let sourceContent = unit.content;

		// from属性がある場合は、インデックスファイルから翻訳元ユニットのコンテンツを取得
		if (unit.marker?.from) {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				const indexFile = await loadIndexFile(workspaceRoot);
				if (indexFile) {
					const sourceUnits = findUnitsByFromHash(indexFile, unit.marker.from);
					if (sourceUnits.length > 0) {
						// 最初に見つかった翻訳元ユニットを使用
						const sourceUnit = sourceUnits[0];
						try {
							const sourceFilePath = path.resolve(workspaceRoot, sourceUnit.path);
							const sourceFileContent = await fs.promises.readFile(sourceFilePath, "utf-8");
							const sourceMarkdown = markdownParser.parse(sourceFileContent, new Configuration());
							const sourceUnitData = sourceMarkdown.units[sourceUnit.unitIndex];
							if (sourceUnitData) {
								sourceContent = sourceUnitData.content;
							}
						} catch (error) {
							console.warn(`Failed to read source unit from ${sourceUnit.path}:`, error);
						}
					} else {
						console.warn(`Source unit not found for hash: ${unit.marker.from}`);
					}
				} else {
					// インデックスファイルがない場合はフォールバック（従来の方式）
					const sourceUnit = findUnitByHash(markdown.units, unit.marker.from);
					if (sourceUnit) {
						sourceContent = sourceUnit.content;
					}
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
 * ハッシュでユニットを検索
 * @param units ユニット配列
 * @param hash 検索対象のハッシュ
 * @returns 見つかったユニット（なければnull）
 */
function findUnitByHash(units: MdaitUnit[], hash: string): MdaitUnit | null {
	return units.find((unit) => unit.marker?.hash === hash) || null;
}
