import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyRevisionPatch, createUnifiedDiff, hasDiff } from "../../core/diff/diff-generator";
import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitMarker, isTranslationNeed } from "../../core/markdown/mdait-marker";
import { type FileStatusItem, Status, StatusItemType } from "../../core/status/status-item";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { Configuration, type TransPair } from "../../infra/config/configuration";
import { OperationCancelledError, isOperationCancelled } from "../../infra/errors/operation-cancelled";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { writeManagedDocument, writeManagedDocumentSync } from "../../infra/workspace/managed-write";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";
import type { DeclareIsolateResult } from "../markers/declare-isolate";
import type { DeleteUnitResult, DeleteUnitsResult } from "../markers/delete-unit";
import type { KeepUnitsResult } from "../markers/keep-unit";
import type { RequestTranslateResult } from "../markers/request-translate";
import {
	DEFAULT_RESOLVABLE_NEEDS,
	type NeedResolutionOptions,
	type NeedTarget,
	type ResolveNeedFileResult,
	needMatchesSelection,
} from "../markers/resolve-need";
import { withFileMutation } from "../markers/unit-mutation";
import { syncMarkerPair } from "../sync/marker-sync";
import { isStaleUntranslatedCopy, isWrittenOverTranslateMark } from "../sync/untranslated-copy";
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
 * 非Markdown の訳文ファイル行の contextValue を決める（ツリーのボタンの出し分け）。
 *
 * ユニット（`determineUnitContextValue`）と同じく **`Status` ではなく need で決める**。
 * `Status` は「原文側か訳文側か／翻訳の進み具合」を表す値で、そこに出し分けを
 * 相乗りさせると、集計都合で `Status` の付け方が変わったときにボタンが巻き添えで消える。
 *
 * - `need:review`（確認待ち）→ `…Attention`: 「レビュー済みにする」だけを出す。
 *   trans は review を訳さない（`isTranslationNeed`）ので、✨翻訳を出しても押して
 *   何も起きない — 押せないものをボタンにしない（ux.md §3.3）
 * - need なし → `…Complete`（TM 登録などの完了後の操作）
 * - それ以外（translate / revise@…）→ `mdaitPlainFileTarget`（✨翻訳）
 */
export function determinePlainFileContextValue(need: string | null | undefined): string {
	if (need === "review") {
		return "mdaitPlainFileTargetAttention";
	}
	if (!need) {
		return "mdaitPlainFileTargetComplete";
	}
	return "mdaitPlainFileTarget";
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

		// 3. UnitStateStoreからターゲットのエントリを取得（非MD はファイル1ユニット＝`getSoleEntry`）
		const store = UnitStateStore.getInstance();
		const existing = store.getSoleEntry(targetRelPath);

		// 4. ターゲットの現在hashを再計算（rebuild の判定にも使う）
		let targetContent = fs.readFileSync(targetFile, "utf-8");
		let targetHash = calculateHash(targetContent, false);

		// 5. まだ訳していない丸写しが古い原文のままなら、いまの原文へ写し直す（Markdown と同じ規則）。
		// 写し直さないと、訳文ファイルに古い原文が残り続けて訳文に見える
		const staleCopy =
			existing && (await isStaleUntranslatedCopy(existing.need, existing.from, targetHash, sourceHash, targetContent));
		if (staleCopy) {
			writeManagedDocumentSync(targetFile, sourceContent);
			targetContent = fs.readFileSync(targetFile, "utf-8");
			targetHash = calculateHash(targetContent, false);
		}

		// 6. need判定。規則は Markdown と同じ `syncMarkerPair`（marker-sync.ts）に任せる。
		// 行が無い（rebuild）ときは紐の無い訳文として渡し、`needForFirstLink` が
		// 「本文あり・丸写しでない → review、丸写し・空 → translate」を決める
		const targetMarker = existing
			? new MdaitMarker(existing.hash, existing.from || null, existing.need || null)
			: new MdaitMarker(targetHash);
		// 翻訳待ちの印を付けたあとで人の文章が書き込まれていたら確認待ちへ切り替える（Markdown と同じ規則）
		const writtenOver =
			!!existing &&
			isWrittenOverTranslateMark(
				existing.need,
				existing.hash,
				existing.from,
				targetHash,
				targetContent,
				sourceContent,
				!!staleCopy,
			);
		if (writtenOver) {
			targetMarker.setNeed("review");
		}
		const existingText = !existing && targetContent.trim() !== "";
		const wasAwaitingReview = existing?.need === "review";
		const result = syncMarkerPair(sourceHash, targetHash, null, targetMarker, {
			existingText,
			// 丸写しかどうかは中身で答える（改行コードだけ違うものは丸写しとみなさない）
			verbatimCopy: existingText ? targetContent === sourceContent : undefined,
		});
		const need = result.targetMarker.need ?? "";

		// 数え方も Markdown と同じ。紐の無い既訳を review で受けたら adopted、改訂待ちは revisionsNeeded
		// 訳文だけが変わった回（hash だけ進む）は従来どおり unchanged に数える
		// 丸写しを写し直した回は訳文ファイルを書いているので、from と need が変わらなくても変更に数える
		const modified = staleCopy || !existing || existing.from !== sourceHash || existing.need !== need ? 1 : 0;
		const becameRevision = modified === 1 && result.targetMarker.needsRevision();
		const revisionsNeeded = becameRevision ? 1 : 0;
		const adopted = (existingText || writtenOver) && need === "review" ? 1 : 0;
		const reviewsSuperseded = wasAwaitingReview && becameRevision ? 1 : 0;
		if (!existing) {
			logger.info("sync", "Rebuild detected for plain file", {
				targetFile: targetRelPath,
				need,
			});
		}

		// 7. UnitRegistryにソースコンテンツのスナップショット保存
		const unitRegistryManager = UnitRegistryManager.getInstance();
		unitRegistryManager.saveUnitRegistry(sourceHash, sourceContent);

		// 8. UnitStateStoreのエントリ更新（非MD＝ファイル1ユニット）
		store.setSoleEntry(targetRelPath, { hash: targetHash, from: sourceHash, need });

		// 9. FileSyncResultを返す
		return {
			added: 0,
			modified,
			deleted: 0,
			unchanged: modified === 0 ? 1 : 0,
			revisionsNeeded,
			adopted,
			reviewsSuperseded,
		};
	}

	async syncNew(sourceFile: string, targetFile: string): Promise<FileSyncResult> {
		const fileExplorer = new FileExplorer();

		// 1. ソースファイル読み込み、ハッシュ計算
		const sourceContent = fs.readFileSync(sourceFile, "utf-8");
		const sourceHash = calculateHash(sourceContent, false);

		// 2. ターゲットファイルにソース内容をコピー。
		// **ここは唯一の入口（writeManagedDocument）を通さない。** まだファイルが無いので
		// 書式は既定（LF）と測られ、CRLF の原文がその場で LF へ倒れる。複製はバイト列を
		// そのまま写すのが正しい。書式を保つ話が効いてくるのは、次にこのファイルへ
		// 訳文を書くとき（translateFile）で、そこは入口を通している
		fileExplorer.ensureTargetDirectoryExists(targetFile);
		fs.writeFileSync(targetFile, sourceContent, "utf-8");

		// 3. UnitStateStoreにエントリ登録（hash=ソースhash, from=ソースhash, need=translate）
		const targetRelPath = toWorkspaceRelativePath(targetFile);
		const store = UnitStateStore.getInstance();
		store.setSoleEntry(targetRelPath, {
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

		// 2. UnitStateStoreからエントリ取得（非MD はファイル1ユニット＝`getSoleEntry`）
		const entry = store.getSoleEntry(targetRelPath);
		if (!entry || !isTranslationNeed(entry.need)) {
			// 翻訳不要。確認待ち（review）も訳さない — 取り込んだ既訳を AI で上書きしてしまう
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
				// 非Markdown なので、コードフェンスやインラインコードの規則は当てない
				const extracted = extractRelevantTerms(sourceContent, allTerms, pair.sourceLang, pair.targetLang, {
					markdown: false,
				});
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
				// 形式は AI に投げた指示文が決めている。**中身から推測しない**（ADR-260903-01）
				const patched = applyRevisionPatch(previousTranslation, patchResult.targetPatch, patchResult.format);
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

		// 11. 結果書き込み。
		// **唯一の入口を通す（ADR-260902-01）。** AI の返す訳文は必ず LF なので、素の書き込みだと
		// Windows で書かれた（CRLF の）訳文が翻訳のたびに全行 LF へ倒れる。非MD でも原稿は原稿で、
		// 拡張子は「勝手に書き換わった」かどうかと関係がない
		await writeManagedDocument(targetFilePath, translatedText);

		// 12. UnitStateStore更新してディスクに保存
		const sourceHash = calculateHash(sourceContent, false);
		store.setSoleEntry(targetRelPath, {
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
		const entry = store.getSoleEntry(targetRelPath);

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
			contextValue: determinePlainFileContextValue(entry.need),
		};
	}

	async isInitialized(filePath: string): Promise<boolean> {
		const targetRelPath = toWorkspaceRelativePath(filePath);
		const store = UnitStateStore.getInstance();
		return store.getSoleEntry(targetRelPath) !== undefined;
	}

	// ===== マーカー／ユニット状態の書き換え =====
	// 非MDファイルは「ファイル＝単一ユニット」（行は `getSoleEntry` / `setSoleEntry` で読み書きする）。need は unit-state のみに存在し本文は変えない。

	async resolveNeed(filePath: string, options: NeedResolutionOptions = {}): Promise<ResolveNeedFileResult> {
		const selected = options.needs && options.needs.length > 0 ? options.needs : [...DEFAULT_RESOLVABLE_NEEDS];
		const relPath = toWorkspaceRelativePath(filePath);

		return withFileMutation<ResolveNeedFileResult>(filePath, Configuration.getInstance(), async () => {
			const store = UnitStateStore.getInstance();
			const entry = store.getSoleEntry(relPath);
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

	async requestTranslate(filePath: string, target: NeedTarget): Promise<RequestTranslateResult> {
		const relPath = toWorkspaceRelativePath(filePath);

		// resolveNeed と同じ経路（withFileMutation）。need はストアにしか無く本文は変えない
		return withFileMutation<RequestTranslateResult>(filePath, Configuration.getInstance(), async () => {
			const store = UnitStateStore.getInstance();
			const entry = store.getSoleEntry(relPath);
			if (!entry) {
				return { requested: false, changed: false, hash: "", reason: "not-found" };
			}
			// hash 指定は照合する（resolveNeed と同じ理由。ファイル＝1ユニットでも、指定と違う
			// ユニットを黙って書き換えると NeedTarget の契約が壊れる）
			if (!matchesPlainTarget([target], entry.hash)) {
				return { requested: false, changed: false, hash: entry.hash, reason: "not-found" };
			}
			if (entry.need !== "review") {
				return { requested: false, changed: false, hash: entry.hash, reason: "not-review" };
			}

			store.setEntry({ ...entry, need: "translate" });
			return { requested: true, changed: true, hash: entry.hash };
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
