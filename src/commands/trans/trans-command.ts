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
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { SelectionState } from "../../core/status/selection-state";
import { StatusCollector } from "../../core/status/status-collector";
import { Status } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { SummaryManager } from "../../ui/hover/summary-manager";
import { FileExplorer } from "../../utils/file-explorer";
import { type TranslationTerm, extractRelevantTerms, termsToJson } from "./term-extractor";
import { TermsCacheManager } from "./terms-cache-manager";
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
				await translateUnit(unit, translator, sourceLang, targetLang);

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

			// 翻訳済みユニットをファイルに保存
			await updateAndSaveUnit(uri, oldMarkerText, unit);
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
 */
async function translateUnit(unit: MdaitUnit, translator: Translator, sourceLang: string, targetLang: string) {
	const statusManager = StatusManager.getInstance();
	const summaryManager = SummaryManager.getInstance();
	const config = Configuration.getInstance();

	const startTime = Date.now();

	try {
		// 用語集の取得（設定が有効な場合のみ）
		const config = Configuration.getInstance();
		let termsJson: string | undefined;
		const relevantTerms: TranslationTerm[] = [];

		try {
			const termsFilePath = config.getTermsFilePath();
			const cacheManager = TermsCacheManager.getInstance();
			const allTerms = await cacheManager.getTerms(termsFilePath, config.transPairs);
			if (allTerms.length > 0) {
				const extractedTerms = extractRelevantTerms(unit.content, allTerms, sourceLang, targetLang);
				relevantTerms.push(...extractedTerms);
				if (extractedTerms.length > 0) {
					termsJson = termsToJson(extractedTerms);
				}
			}
		} catch (error) {
			console.warn("Failed to load terms for translation:", error);
		}

		// 翻訳コンテキストの作成
		// TODO: context に surroundingText を設定するロジックを実装
		const previousText = ""; // 仮の実装
		const nextText = ""; // 仮の実装
		const context = new TranslationContext(previousText, nextText, termsJson);

		let sourceContent = unit.content;

		// from属性がある場合は、StatusManagerベースで翻訳元ユニットのコンテンツを取得
		if (unit.marker?.from) {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				const tree = statusManager.getStatusItemTree();
				const sourceUnit = tree.getUnitByHash(unit.marker.from);
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
		// 翻訳実行（AIから翻訳テキストと用語候補を同時に取得）
		const translationResult = await translator.translate(sourceContent, sourceLang, targetLang, context);

		// ユニットのコンテンツを更新
		unit.content = translationResult.translatedText;

		// ハッシュを再計算してmarkerを更新
		if (unit.marker) {
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;

			// 適用された用語を追跡（原文と訳文の両方に出現する用語）
			const appliedTerms = relevantTerms
				.filter((term) => {
					// 原文に用語の原語が含まれ、訳文に用語の訳語が含まれているかチェック
					const sourceIncludes = sourceContent.toLowerCase().includes(term.term.toLowerCase());
					const targetIncludes = translationResult.translatedText
						.toLowerCase()
						.includes(term.translation.toLowerCase());
					return sourceIncludes && targetIncludes;
				})
				.map((term) => ({
					source: term.term,
					target: term.translation,
					context: term.context,
				}));

			// AIからの用語候補をTermCandidateフォーマットに変換
			const aiTermCandidates =
				translationResult.termSuggestions?.map((suggestion) => ({
					source: suggestion.source,
					target: suggestion.target,
					context: suggestion.reason || "Suggested by AI",
					sourceLang,
					targetLang,
				})) || [];

			// AIの候補を優先し、重複を除去
			const termCandidatesMap = new Map<string, (typeof aiTermCandidates)[0]>();
			for (const candidate of aiTermCandidates) {
				const key = candidate.source.toLowerCase();
				if (!termCandidatesMap.has(key)) {
					termCandidatesMap.set(key, candidate);
				}
			}
			const termCandidates = Array.from(termCandidatesMap.values());

			// 翻訳サマリを保存
			const duration = (Date.now() - startTime) / 1000; // 秒単位
			summaryManager.saveSummary(newHash, {
				unitHash: newHash,
				stats: {
					duration,
					tokens: translationResult.stats?.estimatedTokens,
				},
				appliedTerms: appliedTerms.length > 0 ? appliedTerms : undefined,
				termCandidates: termCandidates.length > 0 ? termCandidates : undefined,
				warnings: translationResult.warnings,
			});
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
		// 各種初期化
		const fileExplorer = new FileExplorer();
		const transPair = fileExplorer.getTransPairFromTarget(targetPath, config);
		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for file: {0}", targetPath));
			return;
		}
		const sourceLang = transPair.sourceLang;
		const targetLang = transPair.targetLang;
		const translator = await new TranslatorBuilder().build();

		// 翻訳対象ユニットの読込
		const uri = vscode.Uri.file(targetPath);
		const document = await vscode.workspace.openTextDocument(uri, { encoding: "utf-8" });
		const content = document.getText();
		const markdown = markdownParser.parse(content, config);

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

		// ステータス: 翻訳中
		statusManager.changeUnitStatus(unitHash, { isTranslating: true }, targetPath);

		const oldMarkerText = targetUnit.marker.toString();

		try {
			// 翻訳実行
			await translateUnit(targetUnit, translator, sourceLang, targetLang);

			// ステータス: 翻訳完了
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
			// ステータス: エラー
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

		// 翻訳済みユニットをファイルに保存
		await updateAndSaveUnit(vscode.Uri.file(targetPath), oldMarkerText, targetUnit);

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
 * 指定ファイルのユニットを更新し、保存する
 */
async function updateAndSaveUnit(file: vscode.Uri, markerText: string, unit: MdaitUnit): Promise<void> {
	const replacement = unit.toString();
	// 文字列でオフセット計算し、fs.writeFileでサイレント更新
	const document = await vscode.workspace.fs.readFile(file);
	const decoder = new TextDecoder("utf-8");
	const content = decoder.decode(document);
	const offsets = getUnitPosition(content, markerText);
	if (!offsets) {
		console.warn("mdait marker not found (fs path). Skipped unit replacement for:", unit.title);
		return;
	}
	// 元のユニットの末尾改行を保持
	const updated = content.slice(0, offsets.start) + replacement + offsets.trailingNewlines + content.slice(offsets.end);
	const encoder = new TextEncoder();
	await vscode.workspace.fs.writeFile(file, encoder.encode(updated));
}

/**
 * マーカーに基づき、文字範囲を返す
 * 元の改行を保持するため、範囲に含まれる末尾の改行情報も返す
 */
function getUnitPosition(
	text: string,
	markerText: string,
): { start: number; end: number; trailingNewlines: string } | null {
	const startIdx = text.indexOf(markerText);
	if (startIdx === -1) {
		return null;
	}
	const markerLen = markerText.length;
	const after = text.slice(startIdx + markerLen);
	const nextMatch = after.match(MdaitMarker.MARKER_REGEX);
	const endIdx = nextMatch ? startIdx + markerLen + (nextMatch.index ?? 0) : text.length;

	// 末尾の改行を検出（次のマーカーまたはファイル末尾までの改行を保持）
	const unitContent = text.slice(startIdx, endIdx);
	const trailingNewlinesMatch = unitContent.match(/(\r?\n)+$/);
	const trailingNewlines = trailingNewlinesMatch ? trailingNewlinesMatch[0] : "";

	return { start: startIdx, end: endIdx, trailingNewlines };
}
