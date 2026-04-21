import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	applySimplePatch,
	createUnifiedDiff,
	hasDiff,
} from "../../core/diff/diff-generator";
import { FileStateStore } from "../../core/file-state/file-state-store";
import { calculateHash } from "../../core/hash/hash-calculator";
import {
	type FileStatusItem,
	Status,
	StatusItemType,
} from "../../core/status/status-item";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import {
	Configuration,
	type TransPair,
} from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { extractRelevantTerms, termsToJson } from "../trans/term-extractor";
import { TermsCacheManager } from "../trans/terms-cache-manager";
import { lookupTmReferences } from "../trans/trans-command";
import { TranslationContext } from "../trans/translation-context";
import type { Translator } from "../trans/translator";
import type {
	FileHandler,
	FileSyncResult,
	FileTranslateResult,
} from "./file-handler";

const logger = Logger.getInstance();

/** need:revise のプレフィックス */
const NEED_REVISE_PREFIX = "revise@";

/**
 * 非Markdownファイル（.txt, .csv, .tsv等）用のFileHandler実装。
 * FileStateStoreで翻訳状態を管理し、ファイル全体を1ユニットとして扱う。
 */
export class PlainFileHandler implements FileHandler {
	readonly fileType = "plain" as const;

	async sync(sourceFile: string, targetFile: string): Promise<FileSyncResult> {
		// 1. ソースファイル全内容を読み込み、CRC32ハッシュ計算（normalize:false）
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		const sourceHash = calculateHash(sourceContent, false);

		// 2. ターゲットのワークスペース相対パスを算出
		const targetRelPath = this.toWorkspaceRelativePath(targetFile);

		// 3. FileStateStoreからターゲットのエントリを取得
		const store = FileStateStore.getInstance();
		const existing = store.getEntry(targetRelPath);

		// 4. need判定
		let need: string;
		let revisionsNeeded = 0;
		let modified = 0;

		if (!existing) {
			// rebuild時: file-state未登録 + ターゲットファイル存在 → need:review
			need = "review";
			revisionsNeeded = 1;
			modified = 1;
			logger.info(
				"sync",
				"Rebuild detected for plain file, assigning need:review",
				{
					targetFile: targetRelPath,
				},
			);
		} else if (existing.fromHash !== sourceHash) {
			// ソース変更あり
			if (existing.need.startsWith(NEED_REVISE_PREFIX)) {
				// 既にrevise中 → 旧基準ハッシュを保持（上書きしない）
				need = existing.need;
			} else {
				need = `${NEED_REVISE_PREFIX}${existing.fromHash}`;
			}
			revisionsNeeded = 1;
			modified = 1;
		} else {
			// ソース変更なし → needそのまま
			need = existing.need;
		}

		// 5. ターゲットの現在hashを再計算
		const targetContent = fs.readFileSync(targetFile, "utf-8");
		const targetHash = calculateHash(targetContent, false);

		// 6. UnitRegistryにソースコンテンツのスナップショット保存
		const unitRegistryManager = UnitRegistryManager.getInstance();
		unitRegistryManager.saveUnitRegistry(sourceHash, sourceContent);

		// 7. FileStateStoreのエントリ更新
		store.setEntry({
			targetPath: targetRelPath,
			hash: targetHash,
			fromHash: sourceHash,
			need,
		});

		// 8. FileSyncResultを返す
		return {
			added: 0,
			modified,
			deleted: 0,
			unchanged: modified === 0 ? 1 : 0,
			revisionsNeeded,
		};
	}

	async syncNew(
		sourceFile: string,
		targetFile: string,
	): Promise<FileSyncResult> {
		const fileExplorer = new FileExplorer();

		// 1. ソースファイル読み込み、ハッシュ計算
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		const sourceHash = calculateHash(sourceContent, false);

		// 2. ターゲットファイルにソース内容をコピー
		fileExplorer.ensureTargetDirectoryExists(targetFile);
		fs.writeFileSync(targetFile, sourceContent, "utf-8");

		// 3. FileStateStoreにエントリ登録（hash=ソースhash, from=ソースhash, need=translate）
		const targetRelPath = this.toWorkspaceRelativePath(targetFile);
		const store = FileStateStore.getInstance();
		store.setEntry({
			targetPath: targetRelPath,
			hash: sourceHash,
			fromHash: sourceHash,
			need: "translate",
		});

		// 4. UnitRegistryにスナップショット保存
		const unitRegistryManager = UnitRegistryManager.getInstance();
		unitRegistryManager.saveUnitRegistry(sourceHash, sourceContent);

		// 5. FileSyncResult(added:1)を返す
		return {
			added: 1,
			modified: 0,
			deleted: 0,
			unchanged: 0,
			revisionsNeeded: 0,
		};
	}

	async translate(
		targetFilePath: string,
		translator: Translator,
		pair: TransPair,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
	): Promise<FileTranslateResult | undefined> {
		const config = Configuration.getInstance();
		const store = FileStateStore.getInstance();
		const unitRegistryManager = UnitRegistryManager.getInstance();
		const targetRelPath = this.toWorkspaceRelativePath(targetFilePath);

		// 1. ファイルサイズチェック
		const stats = fs.statSync(targetFilePath);
		if (stats.size > config.trans.maxFileSize) {
			logger.warn("trans", "Plain file exceeds maxFileSize, skipping", {
				file: targetRelPath,
				size: stats.size,
				maxFileSize: config.trans.maxFileSize,
			});
			return {
				translatedCount: 0,
				patchedCount: 0,
				skippedCount: 1,
				tmHits: 0,
			};
		}

		// 2. FileStateStoreからエントリ取得
		const entry = store.getEntry(targetRelPath);
		if (!entry || !entry.need) {
			// 翻訳不要
			return undefined;
		}

		// 3. ソースファイルパス解決
		const fileExplorer = new FileExplorer();
		const sourceFilePath = fileExplorer.getSourcePath(targetFilePath, pair);
		if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
			logger.warn("trans", "Source file not found for plain translation", {
				targetFile: targetRelPath,
				sourceFile: sourceFilePath,
			});
			return {
				translatedCount: 0,
				patchedCount: 0,
				skippedCount: 1,
				tmHits: 0,
			};
		}

		// 4. ソースファイル読み込み
		const sourceContent = fs.readFileSync(sourceFilePath, "utf-8");
		const fileExtension = path.extname(sourceFilePath);

		// 5. revise判定とdiff生成
		const isRevise = entry.need.startsWith(NEED_REVISE_PREFIX);
		let previousTranslation: string | undefined;
		let sourceDiff: string | undefined;
		let oldSourceContent: string | undefined;

		if (isRevise) {
			// 現在のターゲット内容を前回翻訳として使用
			previousTranslation = fs.readFileSync(targetFilePath, "utf-8");

			// 旧ソースのハッシュから旧ソースコンテンツを取得
			const oldHash = entry.need.slice(NEED_REVISE_PREFIX.length);
			try {
				const oldContent = await unitRegistryManager.loadUnitRegistry(oldHash);
				if (oldContent && hasDiff(oldContent, sourceContent)) {
					sourceDiff = createUnifiedDiff(oldContent, sourceContent);
					oldSourceContent = oldContent;
					logger.debug("trans", "Generated diff for plain file revision", {
						file: targetRelPath,
						oldHash,
					});
				}
			} catch (error) {
				logger.warn("trans", "Failed to generate diff for plain file", {
					file: targetRelPath,
					...formatError(error),
				});
			}
		}

		// 6. 用語集の取得
		let termsJson: string | undefined;
		try {
			const termsFilePath = config.getTermsFilePath();
			const cacheManager = TermsCacheManager.getInstance();
			const allTerms = await cacheManager.getTerms(
				termsFilePath,
				config.transPairs,
			);
			if (allTerms.length > 0) {
				const extracted = extractRelevantTerms(
					sourceContent,
					allTerms,
					pair.sourceLang,
					pair.targetLang,
				);
				if (extracted.length > 0) {
					termsJson = termsToJson(extracted);
				}
			}
		} catch (error) {
			logger.warn(
				"trans",
				"Failed to load terms for plain file translation",
				formatError(error),
			);
		}

		// 7. TranslationContext構築
		const context = new TranslationContext(
			[], // previousTexts — 非MDではユニット周辺コンテキストなし
			[], // nextTexts
			termsJson,
			previousTranslation,
			sourceDiff,
		);
		context.fileExtension = fileExtension;

		// 8. TM参照の検索
		let tmHit = false;
		try {
			const tmResult = lookupTmReferences(
				sourceContent,
				pair.sourceLang,
				pair.targetLang,
				oldSourceContent,
			);
			if (tmResult) {
				context.tmReferences = tmResult.formatted;
				tmHit = true;
			}
		} catch (error) {
			logger.debug(
				"trans",
				"TM reference lookup skipped for plain file",
				formatError(error),
			);
		}

		// 9. 進捗報告
		progress.report({
			message: vscode.l10n.t("Translating {0}", path.basename(targetFilePath)),
		});

		// キャンセルチェック（LLM呼び出し前）
		if (token.isCancellationRequested) {
			return {
				translatedCount: 0,
				patchedCount: 0,
				skippedCount: 1,
				tmHits: 0,
			};
		}

		// 10. 翻訳実行
		let translatedText: string | undefined;
		let termSuggestions:
			| { source: string; target: string; context: string; reason?: string }[]
			| undefined;
		let usedPatchMode = false;

		if (isRevise && previousTranslation && sourceDiff) {
			try {
				const patchResult = await translator.translateRevisionPatch(
					sourceContent,
					pair.sourceLang,
					pair.targetLang,
					context,
					token,
				);
				const patched = applySimplePatch(
					previousTranslation,
					patchResult.targetPatch,
				);
				if (patched) {
					translatedText = patched;
					termSuggestions = patchResult.termSuggestions;
					usedPatchMode = true;
				} else {
					logger.warn(
						"trans",
						"Patch apply failed for plain file, falling back to full translation",
						{ file: targetRelPath },
					);
				}
			} catch (error) {
				logger.warn(
					"trans",
					"Patch translation failed for plain file, falling back",
					{ file: targetRelPath, ...formatError(error) },
				);
			}
		}

		if (!translatedText) {
			const result = await translator.translate(
				sourceContent,
				pair.sourceLang,
				pair.targetLang,
				context,
				token,
			);
			translatedText = result.translatedText;
			termSuggestions = result.termSuggestions;
		}

		// キャンセルチェック（書き込み前）
		if (token.isCancellationRequested) {
			return {
				translatedCount: 0,
				patchedCount: 0,
				skippedCount: 1,
				tmHits: 0,
			};
		}

		// 11. 結果書き込み
		const encoder = new TextEncoder();
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(targetFilePath),
			encoder.encode(translatedText),
		);

		// 12. FileStateStore更新してディスクに保存
		const sourceHash = calculateHash(sourceContent, false);
		store.setEntry({
			targetPath: targetRelPath,
			hash: calculateHash(translatedText, false),
			fromHash: sourceHash,
			need: "",
		});
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			store.save(mdaitDir);
		}

		// 13. UnitRegistry保存
		unitRegistryManager.saveUnitRegistry(sourceHash, sourceContent);

		logger.info("trans", "Plain file translation completed", {
			file: path.basename(targetFilePath),
			mode: usedPatchMode ? "patch" : "full",
			tmHit,
		});

		return {
			translatedCount: usedPatchMode ? 0 : 1,
			patchedCount: usedPatchMode ? 1 : 0,
			skippedCount: 0,
			tmHits: tmHit ? 1 : 0,
		};
	}

	async collectStatus(filePath: string): Promise<FileStatusItem> {
		const fileName = path.basename(filePath);
		const targetRelPath = this.toWorkspaceRelativePath(filePath);
		const store = FileStateStore.getInstance();
		const entry = store.getEntry(targetRelPath);

		if (!entry) {
			// file-stateに未登録 → Source扱い
			return {
				type: StatusItemType.File,
				label: fileName,
				status: Status.Source,
				filePath,
				fileName,
				translatedUnits: 0,
				totalUnits: 1,
				children: [],
				contextValue: "mdaitPlainFileSource",
			};
		}

		// need値からステータスを判定
		const status = entry.need ? Status.NeedsTranslation : Status.Translated;
		const translatedUnits = status === Status.Translated ? 1 : 0;

		// ファイルサイズ上限超過チェック
		let tooltip: string | undefined;
		try {
			const stats = fs.statSync(filePath);
			const config = Configuration.getInstance();
			if (stats.size > config.trans.maxFileSize) {
				tooltip = vscode.l10n.t(
					"File size limit exceeded, translation skipped",
				);
			}
		} catch {
			// ファイルアクセスエラーは無視
		}

		return {
			type: StatusItemType.File,
			label: fileName,
			status,
			filePath,
			fileName,
			translatedUnits,
			totalUnits: 1,
			children: [],
			tooltip,
			contextValue:
				status === Status.Translated
					? "mdaitPlainFileTargetComplete"
					: "mdaitPlainFileTarget",
		};
	}

	async isInitialized(filePath: string): Promise<boolean> {
		const targetRelPath = this.toWorkspaceRelativePath(filePath);
		const store = FileStateStore.getInstance();
		return store.getEntry(targetRelPath) !== undefined;
	}

	/** 絶対パスをワークスペース相対パス（/区切り）に変換 */
	private toWorkspaceRelativePath(absolutePath: string): string {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error("No workspace folder found");
		}
		return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
	}
}
