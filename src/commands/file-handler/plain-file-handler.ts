import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applySimplePatch, createUnifiedDiff, hasDiff } from "../../core/diff/diff-generator";
import { calculateHash } from "../../core/hash/hash-calculator";
import { type FileStatusItem, Status, StatusItemType } from "../../core/status/status-item";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { Configuration, type TransPair } from "../../infra/config/configuration";
import {
	OperationCancelledError,
	isOperationCancelled,
} from "../../infra/errors/operation-cancelled";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";
import type { DeclareIsolateResult } from "../markers/declare-isolate";
import type { DeleteUnitResult, DeleteUnitsResult } from "../markers/delete-unit";
import type { KeepUnitsResult } from "../markers/keep-unit";
import {
	DEFAULT_RESOLVABLE_NEEDS,
	type NeedResolutionOptions,
	type NeedTarget,
	type ResolveNeedFileResult,
	needMatchesSelection,
} from "../markers/resolve-need";
import { withFileMutation } from "../markers/unit-mutation";
import { extractRelevantTerms, termsToJson } from "../trans/term-extractor";
import { TermsCacheManager } from "../trans/terms-cache-manager";
import { lookupTmReferences } from "../trans/trans-command";
import { TranslationContext } from "../trans/translation-context";
import type { Translator } from "../trans/translator";
import type { FileHandler, FileSyncResult, FileTranslateResult } from "./file-handler";

const logger = Logger.getInstance();

/** need:revise のプレフィックス */
const NEED_REVISE_PREFIX = "revise@";

/**
 * 対象指定が、このファイル（＝単一ユニット）に一致するかを判定する。
 * 未指定は全件、`kind:"file"` は常に一致、`kind:"unit"` は hash が一致したときのみ。
 * `kind:"frontmatter"` は非Markdownには存在しないため一致しない。
 */
function matchesPlainTarget(targets: NeedTarget[] | undefined, hash: string): boolean {
	if (!targets) {
		return true;
	}
	return targets.some((t) => t.kind === "file" || (t.kind === "unit" && t.hash === hash));
}

/**
 * 非Markdownファイル（.txt, .csv, .tsv等）用のFileHandler実装。
 * UnitStateStoreで翻訳状態を管理し、ファイル全体を1ユニットとして扱う。
 */
export class PlainFileHandler implements FileHandler {
	readonly fileType = "plain" as const;

	async sync(sourceFile: string, targetFile: string): Promise<FileSyncResult> {
		// 1. ソースファイル全内容を読み込み、CRC32ハッシュ計算（normalize:false）
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		const sourceHash = calculateHash(sourceContent, false);

		// 2. ターゲットのワークスペース相対パスを算出
		const targetRelPath = toWorkspaceRelativePath(targetFile);

		// 3. UnitStateStoreからターゲットのエントリを取得（非MD=order:0）
		const store = UnitStateStore.getInstance();
		const existing = store.getEntry(targetRelPath, 0);

		// 4. need判定
		let need: string;
		let revisionsNeeded = 0;
		let modified = 0;

		if (!existing) {
			// rebuild時: unit-state未登録 + ターゲットファイル存在 → need:review
			need = "review";
			revisionsNeeded = 1;
			modified = 1;
			logger.info("sync", "Rebuild detected for plain file, assigning need:review", {
				targetFile: targetRelPath,
			});
		} else if (existing.from !== sourceHash) {
			// ソース変更あり
			if (existing.need.startsWith(NEED_REVISE_PREFIX)) {
				// 既にrevise中 → 旧基準ハッシュを保持（上書きしない）
				need = existing.need;
			} else {
				need = `${NEED_REVISE_PREFIX}${existing.from}`;
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

		// 7. UnitStateStoreのエントリ更新（非MD=ファイル1ユニット: order:0, level:0, titleHash:""）
		store.setEntry({
			path: targetRelPath,
			order: 0,
			level: 0,
			titleHash: "",
			hash: targetHash,
			from: sourceHash,
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

	async syncNew(sourceFile: string, targetFile: string): Promise<FileSyncResult> {
		const fileExplorer = new FileExplorer();

		// 1. ソースファイル読み込み、ハッシュ計算
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		const sourceHash = calculateHash(sourceContent, false);

		// 2. ターゲットファイルにソース内容をコピー
		fileExplorer.ensureTargetDirectoryExists(targetFile);
		fs.writeFileSync(targetFile, sourceContent, "utf-8");

		// 3. UnitStateStoreにエントリ登録（hash=ソースhash, from=ソースhash, need=translate）
		const targetRelPath = toWorkspaceRelativePath(targetFile);
		const store = UnitStateStore.getInstance();
		store.setEntry({
			path: targetRelPath,
			order: 0,
			level: 0,
			titleHash: "",
			hash: sourceHash,
			from: sourceHash,
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
		const store = UnitStateStore.getInstance();
		const unitRegistryManager = UnitRegistryManager.getInstance();
		const targetRelPath = toWorkspaceRelativePath(targetFilePath);

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

		// 2. UnitStateStoreからエントリ取得（非MD=order:0）
		const entry = store.getEntry(targetRelPath, 0);
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
			const allTerms = await cacheManager.getTerms(termsFilePath, config.transPairs);
			if (allTerms.length > 0) {
				const extracted = extractRelevantTerms(sourceContent, allTerms, pair.sourceLang, pair.targetLang);
				if (extracted.length > 0) {
					termsJson = termsToJson(extracted);
				}
			}
		} catch (error) {
			logger.warn("trans", "Failed to load terms for plain file translation", formatError(error));
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
			const tmResult = lookupTmReferences(sourceContent, pair.sourceLang, pair.targetLang, oldSourceContent);
			if (tmResult) {
				context.tmReferences = tmResult.formatted;
				tmHit = true;
			}
		} catch (error) {
			logger.debug("trans", "TM reference lookup skipped for plain file", formatError(error));
		}

		// 9. 進捗報告
		progress.report({
			message: vscode.l10n.t("Translating {0}", path.basename(targetFilePath)),
		});

		// キャンセルチェック（LLM呼び出し前）。
		// 件数0で返すと呼び出し側が「訳す対象が無かった」と区別できず、
		// 止めたのに「翻訳するものはありませんでした」と出る。中断は中断として投げる
		if (token.isCancellationRequested) {
			throw new OperationCancelledError();
		}

		// 10. 翻訳実行
		let translatedText: string | undefined;
		let termSuggestions: { source: string; target: string; context: string; reason?: string }[] | undefined;
		let usedPatchMode = false;
		// 翻訳結果に付いた警告。非MD経路には TranslationChecker が無いため、
		// ここで拾わないと誰も気づけない（ログにだけは必ず残す）。
		let translationWarnings: string[] = [];
		// そのうち「本文が失われた」ものだけを別に数える。need を立てる判断に使う
		let droppedCodeBlocks = 0;

		if (isRevise && previousTranslation && sourceDiff) {
			try {
				const patchResult = await translator.translateRevisionPatch(
					sourceContent,
					pair.sourceLang,
					pair.targetLang,
					context,
					token,
				);
				const patched = applySimplePatch(previousTranslation, patchResult.targetPatch);
				if (patched.ok) {
					translatedText = patched.text;
					termSuggestions = patchResult.termSuggestions;
					translationWarnings = patchResult.warnings ?? [];
					droppedCodeBlocks = patchResult.droppedCodeBlocks ?? 0;
					usedPatchMode = true;
				} else {
					// 非MDはユニット分割が無く、据え置くと訳文が古いまま残るので全文再翻訳へ倒す。
					// 理由は必ず記録する（以前は理由を持たない null だったため何も残せなかった）
					logger.warn("trans", "Patch apply failed for plain file, falling back to full translation", {
						file: targetRelPath,
						reason: patched.reason,
					});
				}
			} catch (error) {
				// 中断は失敗ではないので握り潰さず伝播させる
				if (isOperationCancelled(error)) {
					throw error;
				}
				logger.warn("trans", "Patch translation failed for plain file, falling back", {
					file: targetRelPath,
					...formatError(error),
				});
			}
		}

		if (!translatedText) {
			const result = await translator.translate(sourceContent, pair.sourceLang, pair.targetLang, context, token);
			translatedText = result.translatedText;
			termSuggestions = result.termSuggestions;
			translationWarnings = result.warnings ?? [];
			droppedCodeBlocks = result.droppedCodeBlocks ?? 0;
		}

		// 警告はすべてログに残す（原因を追えるようにする）。
		if (translationWarnings.length > 0) {
			logger.warn("trans", "Plain file translation produced warnings", {
				file: path.basename(targetFilePath),
				warnings: translationWarnings,
			});
		}

		// need:review を立てるのは「コードブロックが戻らなかった」＝本文が失われたときだけ。
		// 非MDファイルはユニットに割れておらず TranslationChecker も通らないので、
		// ここで倒さないと本文が消えた訳文がそのまま完了になる。
		//
		// 警告があること自体を条件にはしない。JSON 混入検出（sanitizeTranslationOutput）は
		// 「AI が応答のエンベロープを漏らした」を捕まえる道具なので、.json ファイルや
		// JSON の例を含む .txt を訳すと定義上つねに偽陽性になる。翻訳のたびに review が
		// 立つと、確認という仕組みそのものが信用されなくなる。
		if (droppedCodeBlocks > 0) {
			logger.warn("trans", "Plain file translation dropped code blocks", {
				file: path.basename(targetFilePath),
				droppedCodeBlocks,
			});
		}

		// ここでキャンセルを見て結果を捨てない。AI 呼び出しは既に終わって費用も
		// かかっており、捨てると「止めたのに何も残らない」うえ再実行でもう一度課金される。
		// 中断はAI呼び出し前・呼び出し中に効く（上のチェックとトークン伝播）

		// 11. 結果書き込み
		const encoder = new TextEncoder();
		await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFilePath), encoder.encode(translatedText));

		// 12. UnitStateStore更新してディスクに保存
		const sourceHash = calculateHash(sourceContent, false);
		store.setEntry({
			path: targetRelPath,
			order: 0,
			level: 0,
			titleHash: "",
			hash: calculateHash(translatedText, false),
			from: sourceHash,
			need: droppedCodeBlocks > 0 ? "review" : "",
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
		const targetRelPath = toWorkspaceRelativePath(filePath);
		const store = UnitStateStore.getInstance();
		const entry = store.getEntry(targetRelPath, 0);

		if (!entry) {
			// unit-stateに未登録 → Source扱い
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
				tooltip = vscode.l10n.t("File size limit exceeded, translation skipped");
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
			// 非MDはファイル＝1ユニットで children を持たないため、need はファイルレベルに載せる
			// （sync 完了通知の翻訳待ち件数などがユニット横断の集計から拾えるようにする）
			needFlag: entry.need || undefined,
			contextValue: status === Status.Translated ? "mdaitPlainFileTargetComplete" : "mdaitPlainFileTarget",
		};
	}

	async isInitialized(filePath: string): Promise<boolean> {
		const targetRelPath = toWorkspaceRelativePath(filePath);
		const store = UnitStateStore.getInstance();
		return store.getEntry(targetRelPath, 0) !== undefined;
	}

	// ===== マーカー／ユニット状態の書き換え =====
	// 非MDファイルは「ファイル＝単一ユニット」（order=0）。need は unit-state のみに存在し本文は変えない。

	async resolveNeed(filePath: string, options: NeedResolutionOptions = {}): Promise<ResolveNeedFileResult> {
		const selected = options.needs && options.needs.length > 0 ? options.needs : [...DEFAULT_RESOLVABLE_NEEDS];
		const relPath = toWorkspaceRelativePath(filePath);

		return withFileMutation<ResolveNeedFileResult>(filePath, Configuration.getInstance(), async () => {
			const store = UnitStateStore.getInstance();
			const entry = store.getEntry(relPath, 0);
			const empty: ResolveNeedFileResult = {
				resolved: [],
				skipped: [],
				changed: false,
				remainingNeedFlags: [],
			};
			if (!entry) {
				return { ...empty, skipped: [{ hash: "", reason: "not-found" }] };
			}
			// hash 指定は照合する。ファイル＝1ユニットでも、指定と違うユニットを黙って
			// 解決してしまうと NeedTarget の契約が壊れる（エージェントが誤った成功を受け取る）
			if (!matchesPlainTarget(options.targets, entry.hash)) {
				return { ...empty, skipped: [{ hash: entry.hash, reason: "not-found" }], remainingNeedFlags: [entry.need] };
			}
			if (!entry.need) {
				return {
					...empty,
					skipped: [{ hash: entry.hash, reason: "already-resolved" }],
				};
			}
			if (!needMatchesSelection(entry.need, selected)) {
				return {
					...empty,
					skipped: [{ hash: entry.hash, reason: "need-not-selected" }],
					remainingNeedFlags: [entry.need],
				};
			}

			store.setEntry({ ...entry, need: "" });
			return {
				resolved: [{ hash: entry.hash, need: entry.need }],
				skipped: [],
				changed: true,
				remainingNeedFlags: [],
			};
		});
	}

	async declareIsolate(_filePath: string, _target: NeedTarget): Promise<DeclareIsolateResult> {
		// 非MDファイルは「ファイル＝1ユニット」で下流へ伝播する部分構造を持たないため凍結の対象外。
		// 対象外であることを黙って素通りさせず、理由を返して呼び出し側に表示させる
		return { declared: false, changed: false, hash: "", reason: "not-found" };
	}

	async deleteUnit(_filePath: string, _target: NeedTarget): Promise<DeleteUnitResult> {
		// 同上。ファイルそのものの削除は mdait の責務外（エクスプローラで行う）
		return { deleted: false, changed: false, hash: "", reason: "not-found" };
	}

	async keepUnits(_filePath: string, hashes?: string[]): Promise<KeepUnitsResult> {
		// 非MDファイルに verify-deletion が付く経路は無い（孤立の判定はユニット構造を持つMDのみ）。
		// 黙って成功にせず、0件の結果を返して呼び出し側に表示させる
		return {
			kept: [],
			skipped: (hashes ?? []).map((hash) => ({ hash, reason: "not-found" as const })),
			changed: false,
		};
	}

	async deleteAllVerifyDeletion(_filePath: string, _hashes?: string[]): Promise<DeleteUnitsResult> {
		// 同上。ファイルそのものの削除は mdait の責務外（エクスプローラで行う）
		return { deleted: [], changed: false };
	}
}
