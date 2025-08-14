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
import { SelectionState } from "../../core/status/selection-state";
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

	if (!uri) {
		vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
		return;
	}

	try {
		// ファイルパスの取得
		const targetFilePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
		if (!targetFilePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
			return;
		}

		// ファイル探索クラスを初期化
		const fileExplorer = new FileExplorer();
		const transPair = fileExplorer.getTransPairFromTarget(targetFilePath, config);
		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for file: {0}", targetFilePath));
			return;
		}

		const sourceLang = transPair.sourceLang;
		const targetLang = transPair.targetLang;
		const translator = await new TranslatorBuilder().build();

		// Markdown ファイルの読み込みとパース
		const document = await vscode.workspace.openTextDocument(uri);
		const content = document.getText();
		const markdown = markdownParser.parse(content, config);

		// need:translate フラグを持つユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());
		if (unitsToTranslate.length === 0) {
			return;
		}

		// ファイルステータスをInProgressに
		await statusManager.changeFileStatus(targetFilePath, { isTranslating: true });

		// 各ユニットを翻訳し、置換用に旧マーカー文字列を保持しつつ保存
		for (const unit of unitsToTranslate) {
			// 翻訳開始をStatusManagerに通知
			if (unit.marker?.hash) {
				statusManager.changeUnitStatus(unit.marker.hash, { isTranslating: true }, targetFilePath);
			}

			const oldHash = unit.marker?.hash;
			const oldMarkerText = unit.marker?.toString() ?? "";

			try {
				await translateUnit(unit, translator, sourceLang, targetLang, markdown);

				// 翻訳完了をStatusManagerに通知
				if (oldHash) {
					statusManager.changeUnitStatus(
						oldHash,
						{
							status: Status.Translated,
							needFlag: undefined,
							isTranslating: false,
							unitHash: unit.marker.hash,
						},
						targetFilePath,
					);
				}
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

			// 更新されたMarkdownをユニット単位で保存（競合回避）- 1ユニットずつ適用
			await replaceUnitByOldMarker(uri, unit, oldMarkerText);
		}

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
				const sourceUnit = statusManager.getUnitStatusItem(unit.marker.from);
				if (sourceUnit) {
					try {
						if (sourceUnit.filePath) {
							const sourceUri = vscode.Uri.file(sourceUnit.filePath);
							const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
							const sourceFileContent = sourceDoc.getText();
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
 * @param targetPath 対象ファイルのパス
 * @param unitHash 翻訳対象のユニットハッシュ
 */
export async function transUnitCommand(targetPath: string, unitHash: string) {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	try {
		// ファイル探索クラスを初期化
		const fileExplorer = new FileExplorer();
		const transPair = fileExplorer.getTransPairFromTarget(targetPath, config);
		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for file: {0}", targetPath));
			return;
		}

		const sourceLang = transPair.sourceLang;
		const targetLang = transPair.targetLang;
		const translator = await new TranslatorBuilder().build();

		// Markdown ファイルの読み込みとパース
		const uri = vscode.Uri.file(targetPath);
		const document = await vscode.workspace.openTextDocument(uri, { encoding: "utf-8" });
		const content = document.getText();
		const markdown = markdownParser.parse(content, config);

		// 指定されたハッシュのユニットを検索
		const targetUnit = findUnitByHash(markdown.units, unitHash);
		if (!targetUnit) {
			vscode.window.showErrorMessage(vscode.l10n.t("Unit with hash {0} not found in file {1}", unitHash, targetPath));
			return;
		}

		// ユニットが翻訳必要かチェック
		if (!targetUnit.needsTranslation()) {
			vscode.window.showInformationMessage(vscode.l10n.t("Unit {0} does not need translation", unitHash));
			return;
		}

		// 翻訳開始をStatusManagerに通知
		statusManager.changeUnitStatus(unitHash, { isTranslating: true }, targetPath);

		// 旧マーカー文字列を保持（置換範囲の起点に使う）
		const oldMarkerText = targetUnit.marker.toString();
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
				targetPath,
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
				targetPath,
			);
			throw error;
		}

		// 更新されたMarkdownをユニット単位で保存（競合回避）- 1ユニット
		await replaceUnitByOldMarker(vscode.Uri.file(targetPath), targetUnit, oldMarkerText);

		// ファイル全体の状態をStatusManagerで更新
		await statusManager.refreshFileStatus(targetPath);

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

/**
 * ユニットごとに旧マーカーから範囲を特定し、新しいマーカー＋本文で安全に置換する
 */
async function replaceUnitByOldMarker(file: vscode.Uri, unit: MdaitUnit, oldMarkerText: string): Promise<void> {
	// 開いているか判定（開いている場合はエディタ上で編集、開いていなければサイレントに書き換え）
	const isOpen =
		vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === file.fsPath) ||
		vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file.fsPath);
	const replacement = `${unit.marker.toString()}\n${unit.content}\n`;

	// ファイル未表示: 文字列でオフセット計算し、fs.writeFileでサイレント更新
	const document = await vscode.workspace.fs.readFile(file);
	const decoder = new TextDecoder("utf-8");
	const content = decoder.decode(document);
	const offsets = computeOffsetsByOldMarker(content, oldMarkerText);
	if (!offsets) {
		console.warn("mdait marker not found (fs path). Skipped unit replacement for:", unit.title);
		return;
	}
	const updated = content.slice(0, offsets.start) + replacement + content.slice(offsets.end);
	const encoder = new TextEncoder();
	await vscode.workspace.fs.writeFile(file, encoder.encode(updated));
}

/**
 * 旧マーカーのハッシュに基づき、置換対象の文字オフセット範囲を返す（TextDocument不要のサイレント更新用）
 */
function computeOffsetsByOldMarker(text: string, oldMarkerText: string): { start: number; end: number } | null {
	const hashMatch = oldMarkerText.match(/<!--\s*mdait\s+([a-zA-Z0-9]+)/);
	if (!hashMatch) return null;
	const oldHash = hashMatch[1];
	const markerRe = new RegExp(`<!--\\s*mdait\\s+${oldHash}[^>]*-->`, "g");
	const match = [...text.matchAll(markerRe)][0];
	if (!match || match.index == null) return null;

	const startIdx = match.index;
	const markerLen = match[0].length;
	const after = text.slice(startIdx + markerLen);
	const anyMarkerRe = /<!--\s*mdait\s+[a-zA-Z0-9]+[^>]*-->/g;
	const nextMatch = [...after.matchAll(anyMarkerRe)][0];
	const endIdx = nextMatch ? startIdx + markerLen + (nextMatch.index ?? 0) : text.length;
	return { start: startIdx, end: endIdx };
}
