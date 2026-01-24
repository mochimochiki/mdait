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
import { applyUnifiedPatch, createUnifiedDiff, hasDiff } from "../../core/diff/diff-generator";
import { calculateHash } from "../../core/hash/hash-calculator";
import { FrontMatter } from "../../core/markdown/front-matter";
import {
	calculateFrontmatterHash,
	getFrontmatterTranslationKeys,
	getFrontmatterTranslationValues,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../core/markdown/frontmatter-translation";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { SnapshotManager } from "../../core/snapshot/snapshot-manager";
import { SelectionState } from "../../core/status/selection-state";
import { StatusCollector } from "../../core/status/status-collector";
import { Status } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { SummaryManager } from "../../ui/hover/summary-manager";
import { AIOnboarding } from "../../utils/ai-onboarding";
import { FileExplorer } from "../../utils/file-explorer";
import { type TranslationTerm, extractRelevantTerms, termsToJson } from "./term-extractor";
import { TermsCacheManager } from "./terms-cache-manager";
import { TranslationChecker } from "./translation-checker";
import { TranslationContext } from "./translation-context";
import type { TranslationResult, Translator } from "./translator";
import { TranslatorBuilder } from "./translator-builder";

/**
 * Markdownファイルの翻訳コマンド（パブリックAPI）
 * @param uri 翻訳対象ファイルのURI（ファイルパス）
 */
export async function transCommand(uri?: vscode.Uri) {
	if (!uri) {
		vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
		return;
	}

	const targetFilePath = uri.fsPath || vscode.window.activeTextEditor?.document.fileName;
	if (!targetFilePath) {
		vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
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
			title: vscode.l10n.t("Translating {0}", path.basename(targetFilePath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				await transFile_CoreProc(uri, progress, token);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Error during translation: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * Markdownファイルの翻訳処理（中核プロセス）
 *
 * **処理フロー**:
 * 1. 翻訳ペア取得とTranslatorビルド
 * 2. Markdownファイル読み込み＆パース
 * 3. need:translateフラグを持つユニットを抽出
 * 4. 各ユニットを順次翻訳（キャンセルチェック付き）
 * 5. 翻訳結果をファイルに保存
 * 6. StatusManagerでファイルステータス更新
 *
 * @param uri 翻訳対象ファイルのURI
 * @param progress 進捗報告用オブジェクト
 * @param token キャンセルトークン
 */
export async function transFile_CoreProc(
	uri: vscode.Uri,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<void> {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();
	const targetFilePath = uri.fsPath;

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
	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	const frontmatterMarker = parseFrontmatterMarker(markdown.frontMatter);
	const needsFrontmatterTranslation = frontmatterKeys.length > 0 && (frontmatterMarker?.needsTranslation() ?? false);

	// need:translate フラグを持つユニットを抽出
	const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());
	if (!needsFrontmatterTranslation && unitsToTranslate.length === 0) {
		return;
	}

	// ファイルステータスをInProgressに
	await statusManager.changeFileStatus(targetFilePath, { isTranslating: true });

	try {
		// frontmatterの翻訳（必要な場合のみ）
		if (needsFrontmatterTranslation) {
			const sourceFilePath = fileExplorer.getSourcePath(targetFilePath, transPair);
			const updated = await translateFrontmatterIfNeeded(
				markdown,
				sourceFilePath,
				frontmatterKeys,
				translator,
				sourceLang,
				targetLang,
				token,
			);
			if (updated) {
				const encoder = new TextEncoder();
				const updatedContent = markdownParser.stringify(markdown);
				await vscode.workspace.fs.writeFile(uri, encoder.encode(updatedContent));
			}
		}

		// 各ユニットを翻訳し、置換用に旧マーカー文字列を保持しつつ保存
		for (let i = 0; i < unitsToTranslate.length; i++) {
			// キャンセルチェック
			if (token.isCancellationRequested) {
				console.log(`Translation cancelled for ${targetFilePath}`);
				await statusManager.changeFileStatus(targetFilePath, { isTranslating: false });
				vscode.window.showInformationMessage(
					vscode.l10n.t("Translation cancelled for: {0}", path.basename(targetFilePath)),
				);
				return;
			}

			const unit = unitsToTranslate[i];

			// 進捗報告
			progress.report({
				message: vscode.l10n.t("{0}/{1} units", i + 1, unitsToTranslate.length),
				increment: 100 / unitsToTranslate.length,
			});

			// 翻訳開始をStatusManagerに通知
			if (unit.marker?.hash) {
				statusManager.changeUnitStatus(unit.marker.hash, { isTranslating: true }, targetFilePath);
			}

			const oldHash = unit.marker?.hash;
			const oldMarkerText = unit.marker?.toString() ?? "";

			try {
				await translateUnit(unit, translator, sourceLang, targetLang, targetFilePath, token);

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
	} finally {
		// isTranslatingフラグをクリア
		await statusManager.changeFileStatus(targetFilePath, { isTranslating: false });
	}
}

/**
 * 単一ユニットの翻訳処理（中核プロセス）
 *
 * **処理フロー**:
 * 1. 用語集から関連用語を抽出
 * 2. 前回訳文を取得（改訂時）
 * 3. 翻訳コンテキスト構築（周辺ユニット）
 * 4. ソースコンテンツ取得（from属性がある場合）
 * 5. AI翻訳実行
 * 6. ユニットコンテンツ更新とハッシュ再計算
 * 7. 翻訳品質チェック＆need:review設定
 * 8. 翻訳サマリ保存
 *
 * @param unit 翻訳対象のユニット
 * @param translator 翻訳サービス
 * @param sourceLang 翻訳元言語
 * @param targetLang 翻訳先言語
 * @param targetFilePath ターゲットファイルのパス
 * @param cancellationToken キャンセルトークン
 */
async function translateUnit(
	unit: MdaitUnit,
	translator: Translator,
	sourceLang: string,
	targetLang: string,
	targetFilePath: string,
	cancellationToken?: vscode.CancellationToken,
) {
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

		// 前回の訳文を取得（原文が改訂された場合）
		// unit.contentには翻訳前の状態（＝前回の訳文）が含まれている
		const previousTranslation = unit.marker?.from ? unit.content : undefined;
		if (previousTranslation) {
			console.log(`Using previous translation as reference for unit ${unit.marker?.hash}`);
		}

		// 翻訳コンテキストの作成
		// 周辺ユニットの取得
		const contextSize = config.trans.contextSize || 1;
		const previousTexts: string[] = [];
		const nextTexts: string[] = [];

		if (contextSize > 0 && unit.marker?.hash) {
			// StatusManagerから現在のユニットのファイルパスを取得
			try {
				const tree = statusManager.getStatusItemTree();
				const currentStatusUnit = tree.getUnitByHash(unit.marker.hash);

				if (currentStatusUnit?.filePath) {
					const currentUri = vscode.Uri.file(currentStatusUnit.filePath);
					const currentDoc = await vscode.workspace.openTextDocument(currentUri);
					const currentFileContent = currentDoc.getText();
					const currentMarkdown = markdownParser.parse(currentFileContent, config);

					const currentIndex = currentMarkdown.units.findIndex((u) => u.marker?.hash === unit.marker.hash);

					if (currentIndex !== -1) {
						// 前方のユニットを取得
						for (let i = 1; i <= contextSize; i++) {
							const prevIndex = currentIndex - i;
							if (prevIndex >= 0) {
								previousTexts.unshift(currentMarkdown.units[prevIndex].content);
							}
						}

						// 後方のユニットを取得
						for (let i = 1; i <= contextSize; i++) {
							const nextIndex = currentIndex + i;
							if (nextIndex < currentMarkdown.units.length) {
								nextTexts.push(currentMarkdown.units[nextIndex].content);
							}
						}
					}
				}
			} catch (error) {
				console.warn("Failed to get surrounding units for context:", error);
			}
		}

		const context = new TranslationContext(previousTexts, nextTexts, termsJson, previousTranslation);

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

		// revise@{oldhash}形式の場合、スナップショットからdiffを生成（ソースコンテンツ取得後）
		if (unit.marker?.needsRevision()) {
			const oldhash = unit.marker.getOldHashFromNeed();
			if (oldhash) {
				try {
					const snapshotManager = SnapshotManager.getInstance();
					const oldContent = await snapshotManager.loadSnapshot(oldhash);
					if (oldContent && hasDiff(oldContent, sourceContent)) {
						context.sourceDiff = createUnifiedDiff(oldContent, sourceContent);
						console.log(`Generated diff for revision from ${oldhash}`);
					}
				} catch (error) {
					console.warn(`Failed to generate diff for oldhash ${oldhash}:`, error);
				}
			}
		}

		let translationResult: TranslationResult | null = null;

		if (unit.marker?.needsRevision() && previousTranslation && context.sourceDiff) {
			try {
				const patchResult = await translator.translateRevisionPatch(
					sourceContent,
					sourceLang,
					targetLang,
					context,
					cancellationToken,
				);

				const patched = applyUnifiedPatch(previousTranslation, patchResult.targetPatch);
				if (patched) {
					translationResult = {
						translatedText: patched,
						termSuggestions: patchResult.termSuggestions,
						warnings: patchResult.warnings,
						stats: patchResult.stats,
					};
				} else {
					console.warn(`Patch apply failed for unit ${unit.marker?.hash}, fallback to full translation`);
				}
			} catch (error) {
				console.warn(`Patch translation failed for unit ${unit.marker?.hash}, fallback to full translation`, error);
			}
		}

		if (!translationResult) {
			// 翻訳実行（AIから翻訳テキストと用語候補を同時に取得）
			translationResult = await translator.translate(sourceContent, sourceLang, targetLang, context, cancellationToken);
		}

		const resolvedResult = translationResult;
		if (!resolvedResult) {
			throw new Error("Translation result is empty");
		}

		// ユニットのコンテンツを更新
		unit.content = resolvedResult.translatedText;

		// ハッシュを再計算してmarkerを更新
		if (unit.marker) {
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;

			// 適用された用語を追跡（原文と訳文の両方に出現する用語）
			const appliedTerms = relevantTerms
				.filter((term) => {
					// 原文に用語の原語が含まれ、訳文に用語の訳語が含まれているかチェック
					const sourceIncludes = sourceContent.toLowerCase().includes(term.term.toLowerCase());
					const targetIncludes = resolvedResult.translatedText.toLowerCase().includes(term.translation.toLowerCase());
					return sourceIncludes && targetIncludes;
				})
				.map((term) => ({
					source: term.term,
					target: term.translation,
					context: term.context,
				}));

			// AIからの用語候補をTermCandidateフォーマットに変換
			const aiTermCandidates =
				resolvedResult.termSuggestions?.map((suggestion) => ({
					source: suggestion.source,
					target: suggestion.target,
					context: suggestion.context,
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

			// 翻訳品質チェック
			const checker = new TranslationChecker();
			const checkResult = checker.checkTranslationQuality(sourceContent, resolvedResult.translatedText);

			// 確認推奨箇所がある場合はneed:reviewを設定
			if (checkResult.needsReview) {
				unit.marker.setNeed("review");
				console.log(`Setting need:review for unit ${newHash} due to quality concerns`);
			} else {
				// 問題がない場合はneedフラグを削除
				unit.marker.removeNeedTag();
			}

			// 翻訳サマリを保存
			const duration = (Date.now() - startTime) / 1000; // 秒単位
			const reviewReasons = checkResult.reasons.map((r) => r.message);
			summaryManager.saveSummary(newHash, {
				unitHash: newHash,
				stats: {
					duration,
					tokens: resolvedResult.stats?.estimatedTokens,
				},
				appliedTerms: appliedTerms.length > 0 ? appliedTerms : undefined,
				termCandidates: termCandidates.length > 0 ? termCandidates : undefined,
				warnings: resolvedResult.warnings,
				reviewReasons: reviewReasons.length > 0 ? reviewReasons : undefined,
			});
		}
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Unit translation error: {0}", (error as Error).message));
		throw error;
	}
}

async function translateFrontmatterIfNeeded(
	markdown: Markdown,
	sourceFilePath: string | null,
	keys: string[],
	translator: Translator,
	sourceLang: string,
	targetLang: string,
	cancellationToken?: vscode.CancellationToken,
): Promise<boolean> {
	const targetFrontMatter = markdown.frontMatter ?? FrontMatter.empty();
	const marker = parseFrontmatterMarker(targetFrontMatter);

	if (!marker || !marker.needsTranslation()) {
		return false;
	}

	if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
		console.warn(`Source file not found for frontmatter translation: ${sourceFilePath}`);
		return false;
	}

	const decoder = new TextDecoder("utf-8");
	const sourceDoc = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFilePath));
	const sourceContent = decoder.decode(sourceDoc);
	const sourceMarkdown = markdownParser.parse(sourceContent, Configuration.getInstance());
	const sourceFrontMatter = sourceMarkdown.frontMatter;

	const sourceValues = getFrontmatterTranslationValues(sourceFrontMatter, keys);
	if (Object.keys(sourceValues).length === 0) {
		marker.removeNeedTag();
		setFrontmatterMarker(targetFrontMatter, marker);
		markdown.frontMatter = targetFrontMatter;
		return true;
	}

	const isRevision = marker.needsRevision();
	for (const key of keys) {
		const sourceValue = sourceValues[key];
		if (sourceValue === undefined) {
			continue;
		}
		if (cancellationToken?.isCancellationRequested) {
			return false;
		}

		const previousTranslation = isRevision ? targetFrontMatter.get(key) : undefined;
		const context = new TranslationContext(
			[],
			[],
			undefined,
			typeof previousTranslation === "string" ? previousTranslation : undefined,
		);
		const result = await translator.translate(sourceValue, sourceLang, targetLang, context, cancellationToken);
		targetFrontMatter.set(key, result.translatedText);
	}

	const sourceHash = calculateFrontmatterHash(sourceFrontMatter, keys, { allowEmpty: false }) ?? marker.from;
	const targetHash = calculateFrontmatterHash(targetFrontMatter, keys, { allowEmpty: true }) ?? marker.hash;
	if (sourceHash) {
		marker.from = sourceHash;
	}
	if (targetHash) {
		marker.hash = targetHash;
	}
	marker.removeNeedTag();
	setFrontmatterMarker(targetFrontMatter, marker);
	markdown.frontMatter = targetFrontMatter;
	return true;
}

/**
 * 単一ユニットの翻訳を実行する（パブリックAPI）
 * @param targetPath 対象ファイルのパス
 * @param unitHash 翻訳対象のユニットハッシュ
 */
export async function transUnitCommand(targetPath: string, unitHash: string) {
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
			title: vscode.l10n.t("Translating unit {0}", unitHash.substring(0, 8)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				await transUnit_CoreProc(targetPath, unitHash, progress, token);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Error during unit translation: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * 単一ユニットの翻訳処理（中核プロセス）
 *
 * 処理フロー:
 * 1. 翻訳ペア取得とTranslatorビルド
 * 2. 対象ユニットの読み込みと検証
 * 3. 翻訳実行
 * 4. ファイル保存とStatusManager更新
 *
 * @param targetPath 対象ファイルのパス
 * @param unitHash 翻訳対象のユニットハッシュ
 * @param progress 進捗報告用オブジェクト
 * @param token キャンセルトークン
 */
export async function transUnit_CoreProc(
	targetPath: string,
	unitHash: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<void> {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

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

	try {
		// キャンセルチェック
		if (token.isCancellationRequested) {
			console.log(`Translation cancelled for ${targetPath}`);
			await statusManager.changeUnitStatus(unitHash, { isTranslating: false }, targetPath);
			vscode.window.showInformationMessage(
				vscode.l10n.t("Translation cancelled for unit: {0}", unitHash.substring(0, 8)),
			);
			return;
		}

		const oldMarkerText = targetUnit.marker.toString();

		// 翻訳実行（中核プロセス）
		await translateUnit(targetUnit, translator, sourceLang, targetLang, targetPath, token);

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

		// 翻訳済みユニットをファイルに保存
		await updateAndSaveUnit(vscode.Uri.file(targetPath), oldMarkerText, targetUnit);

		// ファイル全体の状態をStatusManagerで更新
		await statusManager.refreshFileStatus(targetPath);

		vscode.window.showInformationMessage(vscode.l10n.t("Unit translation completed: {0}", unitHash));
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
	} finally {
		// isTranslatingフラグをクリア
		statusManager.changeUnitStatus(unitHash, { isTranslating: false }, targetPath);
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

/**
 * frontmatter専用の翻訳コマンド（パブリックAPI）
 * StatusTreeまたはCodeLensから呼び出される
 * @param uri 翻訳対象ファイルのURI
 */
export async function translateFrontmatterCommand(uri?: vscode.Uri) {
	if (!uri) {
		vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
		return;
	}

	const targetFilePath = uri.fsPath;
	if (!targetFilePath) {
		vscode.window.showErrorMessage(vscode.l10n.t("No file selected for translation."));
		return;
	}

	// AI初回利用チェック
	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	// withProgressで進捗表示とキャンセル機能を提供
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Translating {0}", path.basename(targetFilePath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				await translateFrontmatter_CoreProc(uri, progress, token);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Error during translation: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * frontmatter翻訳処理（中核プロセス）
 *
 * @param uri 翻訳対象ファイルのURI
 * @param progress 進捗報告用オブジェクト
 * @param token キャンセルトークン
 */
async function translateFrontmatter_CoreProc(
	uri: vscode.Uri,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<void> {
	const targetFilePath = uri.fsPath;
	const config = Configuration.getInstance();
	const statusManager = StatusManager.getInstance();

	// ファイル探索クラスを初期化
	const fileExplorer = new FileExplorer();
	const transPair = fileExplorer.getTransPairFromTarget(targetFilePath, config);
	if (!transPair) {
		vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for file: {0}", targetFilePath));
		return;
	}

	// ソースファイルパスを取得
	const sourceFilePath = fileExplorer.getSourcePath(targetFilePath, transPair);

	// frontmatterの翻訳キーを取得
	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	if (frontmatterKeys.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("No frontmatter keys configured for translation."));
		return;
	}

	// Translatorをビルド
	const translator = await new TranslatorBuilder().build();
	if (!translator) {
		return;
	}

	// Markdownファイルを読み込み＆パース
	const decoder = new TextDecoder("utf-8");
	const targetDoc = await vscode.workspace.fs.readFile(uri);
	const targetContent = decoder.decode(targetDoc);
	const markdown = markdownParser.parse(targetContent, config);

	// frontmatter翻訳を実行
	const translated = await translateFrontmatterIfNeeded(
		markdown,
		sourceFilePath,
		frontmatterKeys,
		translator,
		transPair.sourceLang,
		transPair.targetLang,
		token,
	);

	if (token.isCancellationRequested) {
		return;
	}

	if (translated) {
		// 翻訳結果をファイルに保存
		const updatedContent = markdownParser.stringify(markdown);
		const encoder = new TextEncoder();
		await vscode.workspace.fs.writeFile(uri, encoder.encode(updatedContent));

		// StatusManagerでファイルステータス更新
		await statusManager.refreshFileStatus(targetFilePath);

		vscode.window.showInformationMessage(vscode.l10n.t("Translation completed"));
	}
}
