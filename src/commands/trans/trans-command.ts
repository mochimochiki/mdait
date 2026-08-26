/**
 * @file trans-command.ts
 * @description
 *   VSCode拡張機能用のMarkdown翻訳コマンドを提供するモジュール。
 *   - ファイル全体またはユニット単位での翻訳処理を実装。
 *   - 翻訳対象ファイルの検出、翻訳ペアの判定、翻訳サービスの呼び出し、状態管理(StatusManager)との連携を行う。
 *   - Markdownユニットのパース・更新・保存、翻訳進捗やエラーの通知も含む。
 * @module commands/trans/trans-command
 */
import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import {
	type PatchFailureReason,
	applySimplePatch,
	createUnifiedDiff,
	hasDiff,
} from "../../core/diff/diff-generator";
import { calculateHash } from "../../core/hash/hash-calculator";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
import { FrontMatter } from "../../core/markdown/front-matter";
import {
	calculateFrontmatterHash,
	getFrontmatterTranslationKeys,
	getFrontmatterTranslationValues,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../core/markdown/frontmatter-translation";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import type { MarkerFileContext, MarkerProvider } from "../../core/markdown/marker-provider";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { SelectionState } from "../../core/status/selection-state";
import { Status } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { searchTmByLines } from "../../core/tm/tm-line-search";
import { formatTmReferences } from "../../core/tm/tm-reference-formatter";
import { TmxStore } from "../../core/tm/tmx-store";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { Configuration, type TransPair } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { isOperationCancelled } from "../../infra/errors/operation-cancelled";
import {
	type UnusableResponseReason,
	isUnusableAIResponse,
} from "../../infra/llm/unusable-response";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import {
	SummaryManager,
	type TmReferenceInfo,
} from "../../ui/hover/summary-manager";
import { getFileHandler } from "../file-handler/file-handler-factory";
import { OperationRegistry } from "../shared/operation-registry";
import {
	reportTransOutcome,
	showConfigError,
	showNeedSyncError,
	showTranslationError,
} from "../shared/guidance";
import {
	type TranslationTerm,
	extractRelevantTerms,
	termsToJson,
} from "./term-extractor";
import { TermsCacheManager } from "./terms-cache-manager";
import { TranslationChecker } from "./translation-checker";
import { TranslationContext } from "./translation-context";
import {
	type UnitLoopResult,
	type UnitPersistOutcome,
	runUnitLoop,
} from "./translation-run";
import type { TranslationResult, Translator } from "./translator";
import { TranslatorBuilder } from "./translator-builder";

const logger = Logger.getInstance();

/**
 * 翻訳がどう終わったか。件数だけでは「AIに届かなかった」と「訳すものが無かった」を
 * 区別できず、利用者が次の一手を選べないため、終わり方を明示的に持つ。
 */
export type TransOutcome =
	/** 1件以上訳した（パッチ失敗による据え置きを含みうる） */
	| "completed"
	/** 訳す対象が無かった */
	| "nothing-to-do"
	/** ユーザーが中断した */
	| "cancelled"
	/** 翻訳ペアが見つからない（未同期・設定ミス） */
	| "no-trans-pair"
	/** 同じ対象を処理中のため受け付けなかった */
	| "busy"
	/** 失敗した（AI 到達不能など。理由は showTranslationError が伝える） */
	| "failed";

/** パッチ適用に失敗して手修正を保ったユニット */
export interface PatchFailureInfo {
	unitHash?: string;
	title?: string;
	reason: PatchFailureReason;
}

/** AI の答えが使えず、訳さずに置いたユニット */
export interface ResponseFailureInfo {
	unitHash?: string;
	title?: string;
	reason: UnusableResponseReason;
}

/** 訳文をファイルへ書き戻せなかったユニット */
export interface WriteFailureInfo {
	unitHash?: string;
	title?: string;
	reason?: string;
}

/**
 * 翻訳の実行オプション
 */
export interface TransRunOptions {
	/**
	 * パッチ適用を使わず必ず全文で訳し直す。
	 * パッチ失敗の報告から「全文で訳し直す」を選んだときだけ true になる。
	 */
	forceFullTranslation?: boolean;
}

/**
 * transコマンドの結果
 */
export interface TransCommandResult {
	/** 終わり方 */
	outcome: TransOutcome;
	/** 処理unit数 */
	unitCount: number;
	/** 実際に翻訳したunit数 */
	translatedCount: number;
	/** patchModeで翻訳したunit数 */
	patchedCount: number;
	/** スキップしたunit数 */
	skippedCount: number;
	/** TM参照ヒット数 */
	tmHits: number;
	/** パッチ適用に失敗し、手修正を保って据え置いたユニット */
	patchFailures: PatchFailureInfo[];
	/**
	 * AI の答えが使えず、訳さずに置いたユニット。
	 * ここに載ったユニットは `translatedCount` に数えない（need も外していない）。
	 */
	responseFailures: ResponseFailureInfo[];
	/** 訳文を書き戻せなかったユニット */
	writeFailures: WriteFailureInfo[];
}

/** 何もしなかったことを表す結果を作る */
function emptyResult(outcome: TransOutcome): TransCommandResult {
	return {
		outcome,
		unitCount: 0,
		translatedCount: 0,
		patchedCount: 0,
		skippedCount: 0,
		tmHits: 0,
		patchFailures: [],
		responseFailures: [],
		writeFailures: [],
	};
}

/**
 * 翻訳の終わり方を通知し、「全文で訳し直す」を選ばれたときは
 * **やり直した側の結果**を呼び手に返す。
 *
 * やり直しの結果を捨てると、訳文が書き換わりハッシュも need も進んでいるのに
 * 「0件翻訳・1件スキップ」という古い結果が返り、返り値を読む側
 * （LM ツール・ステータスツリー・lab の IPC）が実態と食い違う。
 *
 * **必ず排他区間の外から呼ぶこと**（中でボタン付き通知を待つとロックが解放されない）。
 *
 * @param result 通知の対象になる、やり直し前の結果
 * @param label 対象の呼び名（ファイル名・ユニット名）
 * @param retryFullTranslation 全文で訳し直す処理。返り値がそのまま呼び手への結果になる
 */
export async function reportTransOutcomeWithRetry(
	result: TransCommandResult,
	label: string,
	retryFullTranslation: () => Promise<TransCommandResult | undefined>,
	sourcePath?: string,
): Promise<TransCommandResult> {
	let finalResult = result;
	await reportTransOutcome(result, {
		label,
		sourcePath,
		retryFullTranslation: async () => {
			// やり直しが中断・失敗して結果を返さなかったときは、元の結果を保つ
			finalResult = (await retryFullTranslation()) ?? finalResult;
		},
	});
	return finalResult;
}

/**
 * Markdownファイルの翻訳コマンド（パブリックAPI）
 * @param uri 翻訳対象ファイルのURI（ファイルパス）
 */
export async function transCommand(
	uri?: vscode.Uri,
	options?: TransRunOptions,
): Promise<TransCommandResult | undefined> {
	if (!uri) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("No file selected for translation."),
		);
		return;
	}

	const targetFilePath =
		uri.fsPath || vscode.window.activeTextEditor?.document.fileName;
	if (!targetFilePath) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("No file selected for translation."),
		);
		return;
	}

	// **走らせる前の検査は、AI を呼ぶ入口すべてに置く。** sync だけに置いていたので、
	// 訳し先の言語が原文と同じ／空のままでもファイル単位の翻訳は素通りし、
	// 原文がそのまま返って need が外れ、課金だけされていた（実測）
	const validationError = Configuration.getInstance().validateForRun();
	if (validationError) {
		await showConfigError(validationError);
		return;
	}

	// AI初回利用チェック
	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return; // ユーザーがキャンセルした場合
	}

	let result: TransCommandResult;
	try {
		result = await runFileTranslation(uri, options);
	} catch (error) {
		// 失敗の通知もここで1回だけ出す。中断は失敗として出さない
		await showTranslationError(error);
		return emptyResult(isOperationCancelled(error) ? "cancelled" : "failed");
	}

	// 通知は必ず排他区間の外で出す（区間の中で人を待つとロックが解放されない）
	return await reportTransOutcomeWithRetry(
		result,
		path.basename(targetFilePath),
		() => transCommand(uri, { forceFullTranslation: true }),
		targetFilePath,
	);
}

/**
 * ファイル翻訳を、多重起動の拒否・進捗表示・後始末つきで実行する（通知は行わない）。
 *
 * 排他区間（FileMutex）の中では人に問わず他コマンドも起こさない。判断が要る事象は
 * 結果に載せて返し、呼び出し側が区間の外で扱う。
 */
async function runFileTranslation(
	uri: vscode.Uri,
	options?: TransRunOptions,
): Promise<TransCommandResult> {
	const targetFilePath = uri.fsPath;

	// 多重起動の拒否。ここで断ることで、2本目の進捗表示が出て
	// ロック待ちのまま「押したのに何も起きない」状態になるのを防ぐ
	const handle = OperationRegistry.getInstance().acquire({
		kind: "translate",
		scope: "file",
		path: targetFilePath,
	});
	if (!handle) {
		return emptyResult("busy");
	}

	try {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t("Translating {0}", path.basename(targetFilePath)),
				cancellable: true,
			},
			(progress, token) => transFile_CoreProc(uri, progress, token, options),
		);
	} finally {
		handle.release();
	}
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
	options?: TransRunOptions,
): Promise<TransCommandResult> {
	const targetFilePath = uri.fsPath;

	// 翻訳ペアの解決は排他区間の外で行う。見つからないときの案内は「Sync を実行」
	// ボタンを持つが、これを区間の中で待つと sync が同じファイルのロックを取りにいき
	// 永久に解放されない（FileMutex は再入非対応）。
	// 一方、未保存の反映（flushDirtyDocument）は区間の**中**で行う — 区間の外だと
	// ロック待ちのあいだにユーザーが編集し直せてしまい、「保存済みのつもりで古い内容を
	// 読む」「後の保存で翻訳結果が消える」という dirty-document.ts が防いでいる失敗が戻る。
	// 保存が誘発する autoSyncOnSave は VS Code が待たない非同期リスナで、
	// 同じロックの待ち行列に並ぶだけなのでデッドロックにはならない（sync/ai-review と同じ作法）
	const transPair = new FileExplorer().getTransPairFromTarget(
		targetFilePath,
		Configuration.getInstance(),
	);
	if (!transPair) {
		return emptyResult("no-trans-pair");
	}

	// 「このファイルを処理中」を台帳に載せる。ディレクトリ翻訳は複数ファイルを同時に
	// 走らせるため、ここで1ファイルずつ登録しないと「配下のファイルは全部処理中」と
	// 推測するほかなくなり、どこまで進んだかが読めなくなる。
	// 登録は排他区間の外側で行う — ロック待ちの間もそのファイルは着手済みだからである
	const tracked = OperationRegistry.getInstance().track({
		kind: "translate",
		scope: "file",
		path: targetFilePath,
	});
	try {
		// sync・自動sync・他の翻訳と同一ファイルへの書き込みが交錯しないよう排他する
		return await FileMutex.getInstance().runExclusive([targetFilePath], () =>
			transFile_Exclusive(uri, transPair, progress, token, options),
		);
	} finally {
		tracked.release();
	}
}

/**
 * 排他区間の中身。
 *
 * **不変条件: ここで人に問わない・他コマンドを起こさない。**
 * この区間で `showXxxMessage` を await したり `executeCommand` を呼ぶと、
 * FileMutex が再入非対応であるためロックが解放されなくなる。判断が要る事象は
 * すべて結果に載せて返し、呼び出し側が区間の外で扱う。
 */
async function transFile_Exclusive(
	uri: vscode.Uri,
	transPair: TransPair,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
	options?: TransRunOptions,
): Promise<TransCommandResult> {
	const config = Configuration.getInstance();
	const targetFilePath = uri.fsPath;

	// 未保存のエディタ変更をディスクへ反映（バッファとディスクの不整合による翻訳結果消失を防ぐ）
	await flushDirtyDocument(targetFilePath);

	// FileHandlerファクトリ経由でファイルタイプ別にディスパッチ
	const handler = getFileHandler(targetFilePath);
	if (handler.fileType !== "md") {
		const translator = await new TranslatorBuilder().buildPlain();
		try {
			const result = await handler.translate(
				targetFilePath,
				translator,
				transPair,
				progress,
				token,
			);
			if (!result) return emptyResult("nothing-to-do");
			// パッチ適用での更新も「訳した」に数える。非MDハンドラは patch 成功時に
			// translatedCount=0 / patchedCount=1 を返すため、translatedCount だけを見ると
			// 実際にはファイルを書き換えたのに「翻訳するものはありませんでした」になる
			const changed = result.translatedCount + result.patchedCount > 0;
			return {
				outcome: changed ? "completed" : "nothing-to-do",
				unitCount: 1,
				translatedCount: result.translatedCount,
				patchedCount: result.patchedCount,
				skippedCount: result.skippedCount,
				tmHits: result.tmHits,
				patchFailures: [],
				responseFailures: [],
				writeFailures: [],
			};
		} catch (error) {
			if (isOperationCancelled(error)) {
				return emptyResult("cancelled");
			}
			throw error;
		} finally {
			// plain file はファイル変更監視がないため明示的にrefresh。
			// 中断・失敗でも必ず通す（状態表示の取り残しを構造的に無くす）
			await StatusManager.getInstance().refreshFileStatus(targetFilePath);
		}
	}

	const statusManager = StatusManager.getInstance();
	const fileExplorer = new FileExplorer();

	const sourceLang = transPair.sourceLang;
	const targetLang = transPair.targetLang;
	const translator = await new TranslatorBuilder().build();

	// マーカー保管方式に応じた provider/ctx を解決
	const io = resolveMarkerIO(config, targetFilePath, "target");
	const external = config.isExternalMarkers();
	if (external) {
		// external では本文にマーカーが無いため、store から need 等を attach する
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	// Markdown ファイルの読み込みとパース
	const document = await vscode.workspace.openTextDocument(uri);
	const content = document.getText();
	const markdown = markdownParser.parse(content, config, io.provider, io.ctx);
	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	const frontmatterMarker = parseFrontmatterMarker(markdown.frontMatter);
	const needsFrontmatterTranslation =
		frontmatterKeys.length > 0 &&
		(frontmatterMarker?.needsTranslation() ?? false);

	// need:translate フラグを持つユニットを抽出
	// 全般コストガード trans.maxUnitsPerRun で1ファイルあたりの翻訳件数を制限する（0 で上限なし）。
	// 超過分は need:translate のまま残り、次回実行で処理される（冪等）。
	const allUnitsToTranslate = markdown.units.filter((unit) =>
		unit.needsTranslation(),
	);
	const maxUnitsPerRun = config.trans.maxUnitsPerRun;
	const unitsToTranslate =
		maxUnitsPerRun > 0 ? allUnitsToTranslate.slice(0, maxUnitsPerRun) : allUnitsToTranslate;

	if (!needsFrontmatterTranslation && unitsToTranslate.length === 0) {
		return emptyResult("nothing-to-do");
	}

	// 「ここまでの成果」を保持する。中断・失敗のどの経路で抜けても finally で保存する
	let loop: UnitLoopResult<MdaitUnit> | undefined;
	// frontmatter だけ訳してユニットが0件、という場合も「訳した」に数える
	let frontmatterTranslated = false;
	// frontmatter の翻訳で使えない答えを受けたとき、それも「訳せなかったもの」として
	// 数える（本文のユニットと同じ扱い。数えないと通知が実態と食い違う）
	const frontmatterFailures: ResponseFailureInfo[] = [];

	try {
		// frontmatterの翻訳（必要な場合のみ）。frontmatter もツリー上の1行なので、
		// 訳している間だけその行を処理中として登録する
		if (needsFrontmatterTranslation) {
			const sourceFilePath = fileExplorer.getSourcePath(
				targetFilePath,
				transPair,
			);
			const trackedFrontmatter = OperationRegistry.getInstance().track({
				kind: "translate",
				scope: "frontmatter",
				path: targetFilePath,
			});
			let frontmatterOutcome: FrontmatterTranslationOutcome;
			try {
				frontmatterOutcome = await translateFrontmatterIfNeeded(
					markdown,
					sourceFilePath,
					frontmatterKeys,
					translator,
					sourceLang,
					targetLang,
					token,
				);
			} finally {
				trackedFrontmatter.release();
			}
			if (frontmatterOutcome.responseFailure) {
				frontmatterFailures.push({
					title: "frontmatter",
					reason: frontmatterOutcome.responseFailure,
				});
			}
			if (frontmatterOutcome.updated) {
				frontmatterTranslated = true;
				const encoder = new TextEncoder();
				const updatedContent = markdownParser.stringify(markdown, io.provider, io.ctx);
				await vscode.workspace.fs.writeFile(
					uri,
					encoder.encode(updatedContent),
				);
			}
		}

		// 置換用に旧マーカー文字列を保持しておく（翻訳するとマーカーが変わるため）
		const oldMarkerTexts = unitsToTranslate.map(
			(unit) => unit.marker?.toString() ?? "",
		);

		// 進行制御は VS Code 非依存の runUnitLoop に委ねる（単体テストで固定できる）。
		// ここが持つのは「外界へどう触るか」だけ
		loop = await runUnitLoop(unitsToTranslate, {
			isCancelled: () => token.isCancellationRequested,
			onProgress: (index, total) => {
				progress.report({
					message: vscode.l10n.t("{0}/{1} units", index + 1, total),
					increment: 100 / total,
				});
			},
			beginUnit: (unit) => trackUnit(targetFilePath, unit.marker?.hash),
			translateUnit: async (unit) => {
				const oldHash = unit.marker?.hash;
				const metrics = await translateUnit(
					unit,
					translator,
					sourceLang,
					targetLang,
					targetFilePath,
					token,
					options,
				);
				// 訳し終えたユニットは、進行中の見え方を先に更新する（1件ずつ緑になる）。
				// 最終的な整合は finally の refreshFileStatus が担う。
				// 失敗の印付けはここでは行わない — refresh がディスク由来の状態で
				// 上書きするため必ず消える。後始末のあとで markFailedUnit がまとめて行う
				if (!metrics.patchFailure && !metrics.responseFailure && oldHash && unit.marker) {
					statusManager.changeUnitStatus(
						oldHash,
						{
							status: Status.Translated,
							needFlag: undefined,
							unitHash: unit.marker.hash,
						},
						targetFilePath,
					);
				}
				return metrics;
			},
			persistUnit: async (unit, index) => {
				// external は本文にマーカーを書けないため、ループ後の一括保存に委ねる
				if (external) {
					return { written: true };
				}
				return updateAndSaveUnit(uri, oldMarkerTexts[index], unit);
			},
		});

		if (loop.error) {
			throw loop.error;
		}

		logger.info("trans", "Translation completed", {
			file: path.basename(targetFilePath),
			translated: loop.translated,
			skipped: loop.skipped,
			cancelled: loop.cancelled,
		});

		return buildFileResult(
			unitsToTranslate,
			loop,
			frontmatterTranslated,
			frontmatterFailures,
		);
	} finally {
		// **後始末の単一経路。** 中断でも失敗でも必ずここを通る。
		// (1) ここまでの成果を保存する（external は一括保存なので、これが無いと
		//     中断時にその実行の翻訳がすべて失われる）
		// (2) 対象ファイルの状態をディスクから作り直す（旗・contextValue・ハッシュの
		//     取り残しを構造的に無くす。個別に旗を下ろす処理は持たない）
		// frontmatter だけを訳した場合も保存する。P05a で frontmatter マーカーの置き場所が
		// `unit-state` へ移ったため、本文のユニットを1つも訳さなかった実行でも
		// **ストアに書くべき成果がある**。ユニット数だけで判断すると、frontmatter しか
		// 持たないファイルは訳文がディスクに書かれるのに行は `need:translate` のまま残り、
		// ツリーは未翻訳のまま、次の翻訳で AI がもう一度訳す（probe S90）
		if (external && ((loop?.translated ?? 0) > 0 || frontmatterTranslated)) {
			try {
				await saveExternalDocument(uri, markdown, io.provider, io.ctx);
			} catch (error) {
				logger.error("trans", "Failed to persist translations", {
					file: targetFilePath,
					...formatError(error),
				});
			}
		}
		await statusManager.refreshFileStatus(targetFilePath);
		// 失敗したユニットの印は refresh のあとに付け直す。refresh はディスクから
		// 状態を作り直すため翻訳エラーを知らず、先に刻むと必ず消えてしまう
		markFailedUnit(targetFilePath, loop);
	}
}

/**
 * 「このユニットを処理中」を台帳に載せ、区間を閉じる後始末を返す（runUnitLoop の beginUnit 用）。
 *
 * ツリーの回転アイコンの粒度はここだけで決まる。登録しなければ「ファイルが処理中なら
 * 配下ユニットも処理中」と推測するほかなくなり、着手前のユニットまで回り出す。
 */
function trackUnit(targetFilePath: string, unitHash: string | undefined): (() => void) | undefined {
	if (!unitHash) {
		return undefined;
	}
	const handle = OperationRegistry.getInstance().track({
		kind: "translate",
		scope: "unit",
		path: targetFilePath,
		unitHash,
	});
	return () => handle.release();
}

/**
 * 失敗したユニットに Status.Error を刻む（状態の作り直しのあとに呼ぶ）。
 * どのユニットで落ちたかがツリーから読めないと、利用者は原稿のどこを直せばよいか分からない。
 */
function markFailedUnit(
	targetFilePath: string,
	loop: UnitLoopResult<MdaitUnit> | undefined,
): void {
	const hash = loop?.errorUnit?.marker?.hash;
	if (!loop?.error || !hash) {
		return;
	}
	StatusManager.getInstance().changeUnitStatus(
		hash,
		{
			status: Status.Error,
			errorMessage: (loop.error as Error).message,
		},
		targetFilePath,
	);
}

/** 進行制御の結果を、呼び出し側へ返すコマンド結果に変換する */
function buildFileResult(
	units: readonly MdaitUnit[],
	loop: UnitLoopResult<MdaitUnit>,
	frontmatterTranslated = false,
	frontmatterFailures: ResponseFailureInfo[] = [],
): TransCommandResult {
	const describe = (unit: MdaitUnit) => ({
		unitHash: unit.marker?.hash,
		title: unit.title,
	});
	const responseFailures: ResponseFailureInfo[] = [
		...loop.responseFailures.map((f) => ({
			...describe(f.unit),
			reason: f.reason,
		})),
		...frontmatterFailures,
	];
	let outcome: TransOutcome = "completed";
	if (loop.cancelled) {
		outcome = "cancelled";
	} else if (
		loop.translated === 0 &&
		loop.patchFailures.length === 0 &&
		!frontmatterTranslated
	) {
		// 1件も訳せず、その原因が「AI の答えが使えなかった」ことなら、
		// それは「訳すものが無かった」ではなく**失敗**である。取り違えると
		// フォルダ翻訳が成功に数え、「翻訳できました」と嘘の報告になる
		outcome = responseFailures.length > 0 ? "failed" : "nothing-to-do";
	}
	return {
		outcome,
		unitCount: units.length,
		translatedCount: loop.translated,
		patchedCount: loop.patched,
		skippedCount: loop.skipped,
		tmHits: loop.tmHits,
		patchFailures: loop.patchFailures.map((f) => ({
			...describe(f.unit),
			reason: f.reason,
		})),
		responseFailures,
		writeFailures: loop.writeFailures.map((f) => ({
			...describe(f.unit),
			reason: f.reason,
		})),
	};
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
/**
 * AI へ「前回の訳文」として渡す文を決める。
 *
 * 渡してよいのは **`need:revise`（原文が改訂された）ユニットだけ**。
 * `unit.content` には翻訳前の状態が入っているが、それが本当に前回の訳文なのは
 * 改訂のときだけで、初回同期で作られた訳文ユニットの中身は
 * `MdaitUnit.createEmptyTargetUnit` が丸写しした**原文そのもの**である。
 * `from` の有無で判定すると初回翻訳でも真になり、
 * 「原文が改訂されました。前回の訳文を活かして、変わっていない部分は変えないでください」
 * という枠つきで原文を送り返すことになる（実測で user メッセージの 45%）。
 * 取り込み（adopt）した章は `need:review` が付いて翻訳対象にならないので、
 * 「既訳を参考として送る」場面はこの1つしかない。
 *
 * frontmatter 側（`translateFrontmatter`）は元から `needsRevision()` で判定しており、
 * ここだけが食い違っていた。
 *
 * @param unit 翻訳対象のユニット
 * @returns 前回の訳文（改訂でなければ undefined）
 */
export function resolvePreviousTranslation(unit: MdaitUnit): string | undefined {
	return unit.marker?.needsRevision() ? unit.content : undefined;
}

/**
 * translateUnitの結果メトリクス
 */
export interface TranslateUnitMetrics {
	/** patchModeで翻訳したか */
	patched: boolean;
	/** TM参照がヒットしたか */
	tmHit: boolean;
	/**
	 * パッチ適用に失敗したため訳文を据え置いた理由。
	 *
	 * 以前はここで確認ダイアログを出していたが、排他区間の中で人を待つため
	 * キャンセルが効かず、後続の操作もロック待ちで止まっていた。いまは安全側
	 * （手修正を保つ）に倒して理由だけを返し、報告と再実行の判断は区間の外で行う。
	 */
	patchFailure?: PatchFailureReason;
	/**
	 * AI の答えが使えなかったため、訳文にもマーカーにも触れずに置いた理由。
	 *
	 * パッチ失敗と同じ考え方で安全側に倒す。以前は検証に落ちた生応答をそのまま
	 * 訳文にしていたため、途中で切れた JSON が本文になり、need まで外れていた。
	 */
	responseFailure?: UnusableResponseReason;
}

async function translateUnit(
	unit: MdaitUnit,
	translator: Translator,
	sourceLang: string,
	targetLang: string,
	targetFilePath: string,
	cancellationToken?: vscode.CancellationToken,
	options?: TransRunOptions,
): Promise<TranslateUnitMetrics> {
	const statusManager = StatusManager.getInstance();
	const summaryManager = SummaryManager.getInstance();
	const config = Configuration.getInstance();

	const startTime = Date.now();

	// 翻訳開始ログ（DEBUGレベル）
	logger.debug("trans", "Unit translation start", {
		unitHash: unit.marker?.hash,
		title: unit.title,
		patchMode: unit.marker?.needsRevision() ?? false,
	});

	try {
		// 用語集の取得（設定が有効な場合のみ）
		const config = Configuration.getInstance();
		let termsJson: string | undefined;
		const relevantTerms: TranslationTerm[] = [];

		try {
			const termsFilePath = config.getTermsFilePath();
			const cacheManager = TermsCacheManager.getInstance();
			const allTerms = await cacheManager.getTerms(
				termsFilePath,
				config.transPairs,
			);
			if (allTerms.length > 0) {
				const extractedTerms = extractRelevantTerms(
					unit.content,
					allTerms,
					sourceLang,
					targetLang,
				);
				relevantTerms.push(...extractedTerms);
				if (extractedTerms.length > 0) {
					termsJson = termsToJson(extractedTerms);
					logger.info("trans", "Term references found", {
						count: extractedTerms.length,
					});
				}
			}
		} catch (error) {
			logger.warn(
				"trans",
				"Failed to load terms for translation",
				formatError(error),
			);
		}

		// 前回の訳文を取得（**原文が改訂された場合だけ**。判断は resolvePreviousTranslation）
		const previousTranslation = resolvePreviousTranslation(unit);
		if (previousTranslation) {
			logger.debug("trans", "Using previous translation as reference", {
				unitHash: unit.marker?.hash,
			});
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
					const currentDoc =
						await vscode.workspace.openTextDocument(currentUri);
					const currentFileContent = currentDoc.getText();
					const currentIo = resolveMarkerIO(config, currentStatusUnit.filePath, "target");
					const currentMarkdown = markdownParser.parse(
						currentFileContent,
						config,
						currentIo.provider,
						currentIo.ctx,
					);

					const currentIndex = currentMarkdown.units.findIndex(
						(u) => u.marker?.hash === unit.marker.hash,
					);

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
				logger.warn(
					"trans",
					"Failed to get surrounding units for context",
					formatError(error),
				);
			}
		}

		const context = new TranslationContext(
			previousTexts,
			nextTexts,
			termsJson,
			previousTranslation,
		);

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
							const sourceDoc =
								await vscode.workspace.openTextDocument(sourceUri);
							const sourceFileContent = sourceDoc.getText();
							const sourceIo = resolveMarkerIO(config, sourceUnit.filePath, "source");
							const sourceMarkdown = markdownParser.parse(
								sourceFileContent,
								config,
								sourceIo.provider,
								sourceIo.ctx,
							);
							// unitHashでユニットを特定
							const sourceUnitData = sourceMarkdown.units.find(
								(u) => u.marker?.hash === sourceUnit.unitHash,
							);
							if (sourceUnitData) {
								sourceContent = sourceUnitData.content;
							}
						}
					} catch (error) {
						logger.warn("trans", "Failed to read source unit", {
							filePath: sourceUnit.filePath,
							...formatError(error),
						});
					}
				} else {
					logger.warn("trans", "Source unit not found", {
						hash: unit.marker.from,
					});
				}
			}
		}

		// revise@{oldhash}形式の場合、スナップショットからdiffを生成（ソースコンテンツ取得後）
		let oldSourceContent: string | undefined;
		if (unit.marker?.needsRevision()) {
			const oldhash = unit.marker.getOldHashFromNeed();
			if (oldhash) {
				try {
					const unitRegistryManager = UnitRegistryManager.getInstance();
					const oldContent =
						await unitRegistryManager.loadUnitRegistry(oldhash);
					if (oldContent && hasDiff(oldContent, sourceContent)) {
						context.sourceDiff = createUnifiedDiff(oldContent, sourceContent);
						oldSourceContent = oldContent;
						logger.debug("trans", "Generated diff for revision", { oldhash });
					} else {
						logger.debug("trans", "Cannot generate diff for revision", {
							oldhash,
							registryHit: !!oldContent,
							hasDiff: oldContent ? hasDiff(oldContent, sourceContent) : false,
						});
					}
				} catch (error) {
					logger.warn("trans", "Failed to generate diff", {
						oldhash,
						...formatError(error),
					});
				}
			}
		}

		// TM参照の検索（tm.enabledかつTmxStoreが利用可能な場合）
		let tmReferenceMatches: TmReferenceInfo[] | undefined;
		try {
			const tmResult = lookupTmReferences(
				sourceContent,
				sourceLang,
				targetLang,
				oldSourceContent,
			);
			if (tmResult) {
				context.tmReferences = tmResult.formatted;
				tmReferenceMatches = tmResult.matches;
				logger.info("trans", "TM references found", {
					count: tmResult.matches.length,
				});
			}
		} catch (error) {
			logger.debug("trans", "TM reference lookup skipped", formatError(error));
		}

		let translationResult: TranslationResult | null = null;
		let usedPatchMode = false;
		let patchFailure: PatchFailureReason | undefined;

		const canPatch =
			!options?.forceFullTranslation &&
			unit.marker?.needsRevision() &&
			previousTranslation &&
			context.sourceDiff;
		if (!canPatch && unit.marker?.needsRevision() && !options?.forceFullTranslation) {
			logger.debug("trans", "Patch mode unavailable for revision unit", {
				unitHash: unit.marker?.hash,
				hasPreviousTranslation: !!previousTranslation,
				hasSourceDiff: !!context.sourceDiff,
			});
			// **守るものがあるときは、黙って全文で訳し直さない。**
			// 改訂の翻訳は本来パッチで、当てはめに失敗したときは「訳文を据え置いて、
			// 全文で訳し直すか一度だけ確認する」ことになっている。ところが *そもそも
			// 差分が作れなかった* 場合だけ、その安全網を通らずに全文再翻訳が走り、
			// 訳文の手直し（用語の言い回し・注記）が AI の善意次第で消えていた。
			// 通知は成功としか言わないので、消えたことにも気づけない（実測）。
			// 訳文がまだ無いとき（previousTranslation が空）は失うものが無いので、
			// これまでどおり全文で訳す
			if (previousTranslation && !context.sourceDiff) {
				logger.info("trans", "Unit translation kept as-is: cannot build a diff for the revision", {
					unitHash: unit.marker?.hash,
				});
				return {
					patched: false,
					tmHit: !!context.tmReferences,
					patchFailure: "no-source-diff",
				};
			}
		}

		if (canPatch) {
			try {
				const patchResult = await translator.translateRevisionPatch(
					sourceContent,
					sourceLang,
					targetLang,
					context,
					cancellationToken,
					{
						unitHash: unit.marker?.hash,
						title: unit.title,
					},
				);

				const patched = applySimplePatch(
					previousTranslation,
					patchResult.targetPatch,
				);
				if (patched.ok) {
					translationResult = {
						translatedText: patched.text,
						termSuggestions: patchResult.termSuggestions,
						warnings: patchResult.warnings,
						stats: patchResult.stats,
					};
					usedPatchMode = true;
				} else {
					// 全文再翻訳は手修正を消しうるので、ここでは訳文を据え置く。
					// 理由は呼び出し側へ返し、排他区間の外でまとめて報告する
					logger.warn("trans", "Patch apply failed, keeping current translation", {
						unitHash: unit.marker?.hash,
						reason: patched.reason,
						patchContent: patchResult.targetPatch,
						baseContentPreview: previousTranslation.slice(0, 200),
					});
					patchFailure = patched.reason;
				}
			} catch (error) {
				// AI の答えが使えなかった（途中で切れた・空・形が違う）ときは、
				// パッチ失敗と同じく**訳文を据え置く**。理由が違うので別の旗で返す
				if (isUnusableAIResponse(error)) {
					logger.warn("trans", "Unusable AI response for revision patch, keeping current translation", {
						unitHash: unit.marker?.hash,
						reason: error.reason,
						detail: error.detail,
						message: error.message,
					});
					return {
						patched: false,
						tmHit: !!context.tmReferences,
						responseFailure: error.reason,
					};
				}
				// **パッチ失敗として握り潰さない。** ここへ来る例外は AI 到達不能・
				// ネットワーク断・利用上限といった本物の失敗であり（答えが使えない場合は
				// 直前で返しており、適用可否は applySimplePatch が理由つきで返す）、
				// パッチ失敗に丸めると「差分の書き方が違う」という誤った理由を出したうえで、
				// そのユニットを黙って飛ばすことになる
				logger.warn("trans", "Patch translation request failed", {
					unitHash: unit.marker?.hash,
					patchContent:
						(error as { patchContent?: string }).patchContent ?? "N/A",
					...formatError(error),
				});
				throw error;
			}
		}

		// パッチ適用に失敗したユニットは、訳文にもマーカーにも触れずに戻す
		if (patchFailure) {
			logger.info("trans", "Unit translation kept as-is after patch failure", {
				unitHash: unit.marker?.hash,
				reason: patchFailure,
			});
			return { patched: false, tmHit: !!context.tmReferences, patchFailure };
		}

		if (!translationResult) {
			// 翻訳実行（AIから翻訳テキストと用語候補を同時に取得）
			try {
				translationResult = await translator.translate(
					sourceContent,
					sourceLang,
					targetLang,
					context,
					cancellationToken,
					{
						unitHash: unit.marker?.hash,
						title: unit.title,
					},
				);
			} catch (error) {
				// 使えない答えは**採用しない**。原稿もマーカーも触らずに戻る。
				// need:translate が残るので、人にも次の実行にも「まだ済んでいない」と伝わる
				if (isUnusableAIResponse(error)) {
					logger.warn("trans", "Unusable AI response, unit left untranslated", {
						unitHash: unit.marker?.hash,
						title: unit.title,
						reason: error.reason,
						detail: error.detail,
						message: error.message,
					});
					return {
						patched: false,
						tmHit: !!context.tmReferences,
						responseFailure: error.reason,
					};
				}
				throw error;
			}
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
					const sourceIncludes = sourceContent
						.toLowerCase()
						.includes(term.term.toLowerCase());
					const targetIncludes = resolvedResult.translatedText
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
			const checkResult = checker.checkTranslationQuality(
				sourceContent,
				resolvedResult.translatedText,
			);

			// 確認推奨箇所がある場合はneed:reviewを設定
			if (checkResult.needsReview) {
				unit.marker.setNeed("review");
				logger.info(
					"trans",
					"Setting need:review for unit due to quality concerns",
					{ unitHash: newHash },
				);
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
				tmReferences: tmReferenceMatches,
				warnings: resolvedResult.warnings,
				reviewReasons: reviewReasons.length > 0 ? reviewReasons : undefined,
			});

			// 翻訳完了ログ（start情報も含める）
			logger.info("trans", "Unit translation completed", {
				unitHash: newHash,
				title: unit.title,
				patchMode: usedPatchMode,
				tmHit: !!context.tmReferences,
				termHit: relevantTerms.length > 0,
				duration,
				needsReview: checkResult.needsReview,
			});
		}

		return {
			patched: usedPatchMode,
			tmHit: !!context.tmReferences,
		};
	} catch (error) {
		// 通知は呼び出し側（transUnitCommand / ファイル翻訳のエラー処理）に一本化し、
		// ここではログのみ残して伝播させる（同一エラーの二重トーストを防ぐ）
		logger.error("trans", "Unit translation error", {
			unitHash: unit.marker?.hash,
			...formatError(error),
		});
		throw error;
	}
}

/**
 * frontmatter 翻訳の終わり方。
 *
 * 本文のユニットと同じで、「AI の答えが使えなかった」は**訳さなかった**として返す。
 * 真偽値ひとつでは「訳すものが無かった」と区別できず、need を外したまま
 * 壊れた値を書くか、黙って「何もありませんでした」と報告するかしか選べない。
 */
interface FrontmatterTranslationOutcome {
	/** frontmatter を書き換えたか（呼び出し側はこれが true のときだけ保存する） */
	updated: boolean;
	/** AI の答えが使えなかった理由（あれば） */
	responseFailure?: UnusableResponseReason;
}

async function translateFrontmatterIfNeeded(
	markdown: Markdown,
	sourceFilePath: string | null,
	keys: string[],
	translator: Translator,
	sourceLang: string,
	targetLang: string,
	cancellationToken?: vscode.CancellationToken,
): Promise<FrontmatterTranslationOutcome> {
	const targetFrontMatter = markdown.frontMatter ?? FrontMatter.empty();
	const marker = parseFrontmatterMarker(targetFrontMatter);

	if (!marker || !marker.needsTranslation()) {
		return { updated: false };
	}

	if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
		logger.warn("trans", "Source file not found for frontmatter translation", {
			sourceFilePath,
		});
		return { updated: false };
	}

	const decoder = new TextDecoder("utf-8");
	const sourceDoc = await vscode.workspace.fs.readFile(
		vscode.Uri.file(sourceFilePath),
	);
	const sourceContent = decoder.decode(sourceDoc);
	// frontmatter のみ使用するが、マーカー読取の単一経路（resolveMarkerIO）を通しておく
	const sourceConfig = Configuration.getInstance();
	const sourceIO = resolveMarkerIO(sourceConfig, sourceFilePath, "source");
	const sourceMarkdown = markdownParser.parse(
		sourceContent,
		sourceConfig,
		sourceIO.provider,
		sourceIO.ctx,
	);
	const sourceFrontMatter = sourceMarkdown.frontMatter;

	const sourceValues = getFrontmatterTranslationValues(sourceFrontMatter, keys);
	if (Object.keys(sourceValues).length === 0) {
		marker.removeNeedTag();
		setFrontmatterMarker(targetFrontMatter, marker);
		markdown.frontMatter = targetFrontMatter;
		return { updated: true };
	}

	// **訳し終えるまで frontmatter に書かない。** 鍵が複数あるとき、途中の鍵で
	// 使えない答えを受けたら、そこまでの結果ごと捨てる。書きながら進めると、
	// 半分だけ訳された frontmatter が need の外れた状態で残り、
	// 「どこまで訳されているのか」が誰にも分からなくなる
	const translatedValues: Record<string, string> = {};
	const isRevision = marker.needsRevision();
	for (const key of keys) {
		const sourceValue = sourceValues[key];
		if (sourceValue === undefined) {
			continue;
		}
		if (cancellationToken?.isCancellationRequested) {
			return { updated: false };
		}

		const previousTranslation = isRevision
			? targetFrontMatter.get(key)
			: undefined;
		const context = new TranslationContext(
			[],
			[],
			undefined,
			typeof previousTranslation === "string" ? previousTranslation : undefined,
		);
		let result: TranslationResult;
		try {
			result = await translator.translate(
				sourceValue,
				sourceLang,
				targetLang,
				context,
				cancellationToken,
			);
		} catch (error) {
			// 使えない答えは採用しない。frontmatter も need も元のまま残す
			if (isUnusableAIResponse(error)) {
				logger.warn("trans", "Unusable AI response, frontmatter left untranslated", {
					key,
					reason: error.reason,
					detail: error.detail,
					message: error.message,
				});
				return { updated: false, responseFailure: error.reason };
			}
			throw error;
		}
		translatedValues[key] = result.translatedText;
	}

	for (const [key, value] of Object.entries(translatedValues)) {
		targetFrontMatter.set(key, value);
	}

	const sourceHash =
		calculateFrontmatterHash(sourceFrontMatter, keys, { allowEmpty: false }) ??
		marker.from;
	const targetHash =
		calculateFrontmatterHash(targetFrontMatter, keys, { allowEmpty: true }) ??
		marker.hash;
	if (sourceHash) {
		marker.from = sourceHash;
	}
	if (targetHash) {
		marker.hash = targetHash;
	}
	marker.removeNeedTag();
	setFrontmatterMarker(targetFrontMatter, marker);
	markdown.frontMatter = targetFrontMatter;

	logger.info("trans", "frontmatter translation completed", {
		updatedKeys: Object.keys(translatedValues),
		newHash: marker.hash,
		newFrom: marker.from,
	});

	return { updated: true };
}

/**
 * 単一ユニットの翻訳を実行する（パブリックAPI）
 * @param targetPath 対象ファイルのパス
 * @param unitHash 翻訳対象のユニットハッシュ
 */
export async function transUnitCommand(
	targetPath: string,
	unitHash: string,
	options?: TransRunOptions,
): Promise<TransCommandResult> {
	// 走らせる前の検査（transCommand と同じ理由。AI を呼ぶ入口すべてに置く）
	const validationError = Configuration.getInstance().validateForRun();
	if (validationError) {
		await showConfigError(validationError);
		return emptyResult("failed");
	}

	// AI初回利用チェック
	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return emptyResult("cancelled");
	}

	// 多重起動の拒否。同じファイルを処理中なら、待たせずに断る
	const handle = OperationRegistry.getInstance().acquire({
		kind: "translate",
		scope: "unit",
		path: targetPath,
		unitHash,
	});
	let result: TransCommandResult;
	if (!handle) {
		result = emptyResult("busy");
	} else {
		try {
			result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Translating unit {0}", unitHash.substring(0, 8)),
					cancellable: true,
				},
				(progress, token) =>
					transUnit_CoreProc(targetPath, unitHash, progress, token, options),
			);
		} catch (error) {
			await showTranslationError(error);
			return emptyResult(isOperationCancelled(error) ? "cancelled" : "failed");
		} finally {
			handle.release();
		}
	}

	// 通知は排他区間の外で1回だけ出す（結果を見ずに成功を出す呼び出し口を無くす）
	return await reportTransOutcomeWithRetry(result, vscode.l10n.t("unit {0}", unitHash.substring(0, 8)), () =>
		transUnitCommand(targetPath, unitHash, { forceFullTranslation: true }),
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
	options?: TransRunOptions,
): Promise<TransCommandResult> {
	// 翻訳ペアの解決だけ区間の外で行う（見つからないときの案内が「Sync を実行」
	// ボタンを持つため）。未保存の反映は区間の中で行う
	const transPair = new FileExplorer().getTransPairFromTarget(
		targetPath,
		Configuration.getInstance(),
	);
	if (!transPair) {
		return emptyResult("no-trans-pair");
	}

	// sync・自動sync・他の翻訳と同一ファイルへの書き込みが交錯しないよう排他する
	return FileMutex.getInstance().runExclusive([targetPath], () =>
		transUnit_Exclusive(targetPath, unitHash, transPair, progress, token, options),
	);
}

/**
 * 排他区間の中身（単一ユニット）。
 * **不変条件: ここで人に問わない・他コマンドを起こさない。**
 */
async function transUnit_Exclusive(
	targetPath: string,
	unitHash: string,
	transPair: TransPair,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
	options?: TransRunOptions,
): Promise<TransCommandResult> {
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	// 未保存のエディタ変更をディスクへ反映（バッファとディスクの不整合による翻訳結果消失を防ぐ）
	await flushDirtyDocument(targetPath);

	const sourceLang = transPair.sourceLang;
	const targetLang = transPair.targetLang;
	const translator = await new TranslatorBuilder().build();

	// マーカー保管方式に応じた provider/ctx を解決
	const io = resolveMarkerIO(config, targetPath, "target");
	const external = config.isExternalMarkers();
	if (external) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	// 翻訳対象ユニットの読込
	const uri = vscode.Uri.file(targetPath);
	const document = await vscode.workspace.openTextDocument(uri, {
		encoding: "utf-8",
	});
	const content = document.getText();
	const markdown = markdownParser.parse(content, config, io.provider, io.ctx);

	const targetUnit = findUnitByHash(markdown.units, unitHash);
	// 見つからない／訳す必要がない、はどちらも「訳すものが無かった」。
	// 以前はここで別々のトーストを出しつつ、呼び出し口が結果を見ずに
	// 「翻訳完了」を重ねて出していた
	if (!targetUnit || !targetUnit.needsTranslation()) {
		logger.info("trans", "Unit translation skipped", {
			targetPath,
			unitHash,
			found: !!targetUnit,
		});
		return emptyResult("nothing-to-do");
	}

	let loop: UnitLoopResult<MdaitUnit> | undefined;
	try {
		const oldMarkerText = targetUnit.marker.toString();
		loop = await runUnitLoop([targetUnit], {
				isCancelled: () => token.isCancellationRequested,
				onProgress: () => {
					progress.report({ message: vscode.l10n.t("{0}/{1} units", 1, 1) });
				},
				beginUnit: (unit) => trackUnit(targetPath, unit.marker?.hash),
				translateUnit: async (unit) => {
					const metrics = await translateUnit(
						unit,
						translator,
						sourceLang,
						targetLang,
						targetPath,
						token,
						options,
					);
					// 失敗の印付けは後始末のあと（markFailedUnit）にまとめる
					if (!metrics.patchFailure) {
						statusManager.changeUnitStatus(
							unitHash,
							{
								status: Status.Translated,
								needFlag: undefined,
								unitHash: unit.marker.hash,
							},
							targetPath,
						);
					}
					return metrics;
				},
				persistUnit: async (unit) => {
					if (external) {
						return { written: true };
					}
					return updateAndSaveUnit(
						vscode.Uri.file(targetPath),
						oldMarkerText,
						unit,
					);
			},
		});
	} finally {
		// 後始末の単一経路。中断でも失敗でも必ず通る
		if (external && (loop?.translated ?? 0) > 0) {
			try {
				await saveExternalDocument(uri, markdown, io.provider, io.ctx);
			} catch (error) {
				logger.error("trans", "Failed to persist translation", {
					file: targetPath,
					...formatError(error),
				});
			}
		}
		await statusManager.refreshFileStatus(targetPath);
		markFailedUnit(targetPath, loop);
	}

	if (loop.error) {
		throw loop.error;
	}
	return buildFileResult([targetUnit], loop);
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
 * external マーカーモードで、翻訳後の Markdown 全体を書き戻し UnitStateStore を保存する。
 *
 * embedded ではマーカーが本文に埋め込まれているため `updateAndSaveUnit` による
 * ユニット単位の部分書き込みを使うが、external では本文にマーカーが無く位置特定できないため、
 * 全文 stringify（マーカーは store へ detach・本文には出力しない）で書き戻す。
 */
async function saveExternalDocument(
	uri: vscode.Uri,
	markdown: Markdown,
	provider: MarkerProvider,
	ctx: MarkerFileContext | undefined,
): Promise<void> {
	const updatedContent = markdownParser.stringify(markdown, provider, ctx);
	const encoder = new TextEncoder();
	await vscode.workspace.fs.writeFile(uri, encoder.encode(updatedContent));
	const mdaitDir = await ensureMdaitDir();
	if (mdaitDir) {
		UnitStateStore.getInstance().save(mdaitDir);
	}
}

/**
 * 指定ファイルのユニットを更新し、保存する。
 *
 * **失敗しても通知しない。** ここは排他区間の中であり、以前はマーカーが
 * 見つからないときに「Sync を実行」ボタン付きの警告を await していた。
 * そのボタンを押すと sync が同じファイルのロックを取りにいき、FileMutex が
 * 再入非対応であるためロックが永久に解放されなくなっていた。
 * 失敗は結果として返し、呼び出し側が区間の外で報告する。
 */
async function updateAndSaveUnit(
	file: vscode.Uri,
	markerText: string,
	unit: MdaitUnit,
): Promise<UnitPersistOutcome> {
	const replacement = unit.toString();
	// 文字列でオフセット計算し、fs.writeFileでサイレント更新
	const document = await vscode.workspace.fs.readFile(file);
	const decoder = new TextDecoder("utf-8");
	const content = decoder.decode(document);
	const offsets = getUnitPosition(content, markerText);
	if (!offsets) {
		logger.warn("trans", "mdait marker not found, skipped unit replacement", {
			unitTitle: unit.title,
		});
		return { written: false, reason: "marker-not-found" };
	}
	// 元のユニットの末尾改行を保持
	const updated =
		content.slice(0, offsets.start) +
		replacement +
		offsets.trailingNewlines +
		content.slice(offsets.end);
	const encoder = new TextEncoder();
	await vscode.workspace.fs.writeFile(file, encoder.encode(updated));
	return { written: true };
}

/**
 * マーカーに基づき、文字範囲を返す
 * 元の改行を保持するため、範囲に含まれる末尾の改行情報も返す
 * コードブロック内のマーカーは次の境界として選択しない
 */
export function getUnitPosition(
	text: string,
	markerText: string,
): { start: number; end: number; trailingNewlines: string } | null {
	const codeBlockLines = getCodeBlockLineSet(text);
	/** 文字位置が何行目か（0 起点） */
	const lineOf = (charPos: number): number => text.slice(0, charPos).split("\n").length - 1;

	// **書き込み先の探索でもコードブロック行を外す。** 外さないと、マーカーの書き方を
	// 解説する原稿（コード例の中に本物のマーカーを貼ったもの）で、訳文がコードブロックの
	// 中へ書き込まれる。コードフェンスが閉じなくなり、以降の構造ごと壊れる。
	// 終端の探索は元から外していたので、片側だけが守られていた
	let startIdx = -1;
	for (let idx = text.indexOf(markerText); idx !== -1; idx = text.indexOf(markerText, idx + 1)) {
		if (!codeBlockLines.has(lineOf(idx))) {
			startIdx = idx;
			break;
		}
	}
	if (startIdx === -1) {
		return null;
	}
	const markerLen = markerText.length;
	const after = text.slice(startIdx + markerLen);

	const globalRegex = new RegExp(MdaitMarker.MARKER_REGEX.source, "g");
	let chosenIndex: number | null = null;
	for (const m of after.matchAll(globalRegex)) {
		const absCharPos = startIdx + markerLen + (m.index ?? 0);
		if (codeBlockLines.has(lineOf(absCharPos))) {
			continue; // コードブロック内はスキップ
		}
		chosenIndex = m.index ?? 0;
		break;
	}

	const endIdx = chosenIndex !== null
		? startIdx + markerLen + chosenIndex
		: text.length;

	// 末尾の改行を検出（次のマーカーまたはファイル末尾までの改行を保持）
	const unitContent = text.slice(startIdx, endIdx);
	const trailingNewlinesMatch = unitContent.match(/(\r?\n)+$/);
	const trailingNewlines = trailingNewlinesMatch
		? trailingNewlinesMatch[0]
		: "";

	return { start: startIdx, end: endIdx, trailingNewlines };
}

/**
 * frontmatter専用の翻訳コマンド（パブリックAPI）
 * StatusTreeまたはCodeLensから呼び出される
 * @param uri 翻訳対象ファイルのURI
 */
export async function translateFrontmatterCommand(uri?: vscode.Uri) {
	if (!uri) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("No file selected for translation."),
		);
		return;
	}

	const targetFilePath = uri.fsPath;
	if (!targetFilePath) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("No file selected for translation."),
		);
		return;
	}

	// AI初回利用チェック
	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	// withProgressで進捗表示とキャンセル機能を提供
	let outcome: FrontmatterOutcome | undefined;
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Translating {0}", path.basename(targetFilePath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				outcome = await translateFrontmatter_CoreProc(uri, progress, token);
			} catch (error) {
				await showTranslationError(error);
			}
		},
	);

	// 通知は排他区間の外で1回だけ出す。どの終わり方でも黙らない（UX-P7）
	const label = path.basename(targetFilePath);
	if (outcome === "no-trans-pair") {
		await showNeedSyncError(
			vscode.l10n.t("No translation pair found for file: {0}", targetFilePath),
		);
	} else if (outcome === "no-keys") {
		vscode.window.showInformationMessage(
			vscode.l10n.t("No frontmatter keys configured for translation."),
		);
	} else if (outcome === "cancelled") {
		vscode.window.showInformationMessage(
			vscode.l10n.t("Translation cancelled for {0}.", label),
		);
	} else if (outcome === "ai-response-unusable") {
		// 黙らない。何も書いていないこと・まだ訳されていないことを伝える
		vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Could not translate the frontmatter of {0}: the AI's answer could not be used. Nothing was changed; it still needs translation.",
				label,
			),
		);
	} else if (outcome === "nothing-to-do") {
		vscode.window.showInformationMessage(
			vscode.l10n.t("Nothing to translate in {0}.", label),
		);
	} else if (outcome === "completed") {
		vscode.window.showInformationMessage(vscode.l10n.t("Translation completed"));
	}
}

/**
 * frontmatter翻訳処理（中核プロセス）
 *
 * @param uri 翻訳対象ファイルのURI
 * @param progress 進捗報告用オブジェクト
 * @param token キャンセルトークン
 */
/** frontmatter 翻訳の終わり方 */
type FrontmatterOutcome =
	| "completed"
	| "nothing-to-do"
	| "cancelled"
	| "no-keys"
	| "no-trans-pair"
	/** AI は答えたが、その答えが使えなかった（何も書いていない） */
	| "ai-response-unusable";

async function translateFrontmatter_CoreProc(
	uri: vscode.Uri,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<FrontmatterOutcome> {
	const targetFilePath = uri.fsPath;

	// 翻訳ペアの解決だけ区間の外で行う。未保存の反映は区間の中
	const transPair = new FileExplorer().getTransPairFromTarget(
		targetFilePath,
		Configuration.getInstance(),
	);
	if (!transPair) {
		return "no-trans-pair";
	}

	// sync・自動sync・他の翻訳と同一ファイルへの書き込みが交錯しないよう排他する
	return FileMutex.getInstance().runExclusive([targetFilePath], () =>
		translateFrontmatter_Exclusive(uri, transPair, progress, token),
	);
}

/**
 * **不変条件: ここで人に問わない・他コマンドを起こさない。**
 * 通知に必要な情報は戻り値で返し、呼び出し側が区間の外で伝える。
 */
async function translateFrontmatter_Exclusive(
	uri: vscode.Uri,
	transPair: TransPair,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<FrontmatterOutcome> {
	const targetFilePath = uri.fsPath;
	const config = Configuration.getInstance();
	const statusManager = StatusManager.getInstance();
	const fileExplorer = new FileExplorer();

	// 未保存のエディタ変更をディスクへ反映
	await flushDirtyDocument(targetFilePath);

	// ソースファイルパスを取得
	const sourceFilePath = fileExplorer.getSourcePath(targetFilePath, transPair);

	// frontmatterの翻訳キーを取得
	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	if (frontmatterKeys.length === 0) {
		return "no-keys";
	}

	// Translatorをビルド
	const translator = await new TranslatorBuilder().build();

	// マーカー保管方式に応じた provider/ctx を解決
	const io = resolveMarkerIO(config, targetFilePath, "target");
	if (config.isExternalMarkers()) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	// Markdownファイルを読み込み＆パース
	const decoder = new TextDecoder("utf-8");
	const targetDoc = await vscode.workspace.fs.readFile(uri);
	const targetContent = decoder.decode(targetDoc);
	const markdown = markdownParser.parse(targetContent, config, io.provider, io.ctx);

	// frontmatter翻訳を実行
	const frontmatterOutcome = await translateFrontmatterIfNeeded(
		markdown,
		sourceFilePath,
		frontmatterKeys,
		translator,
		transPair.sourceLang,
		transPair.targetLang,
		token,
	);

	if (token.isCancellationRequested) {
		return "cancelled";
	}

	// 使えない答えのときは何も書かない。「訳すものが無かった」と混ぜない
	if (frontmatterOutcome.responseFailure) {
		return "ai-response-unusable";
	}

	if (frontmatterOutcome.updated) {
		// 翻訳結果をファイルに保存（external は本文にマーカーを出力せず store へ保存）
		if (config.isExternalMarkers()) {
			await saveExternalDocument(uri, markdown, io.provider, io.ctx);
		} else {
			const updatedContent = markdownParser.stringify(markdown);
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(uri, encoder.encode(updatedContent));
		}

		// StatusManagerでファイルステータス更新
		await statusManager.refreshFileStatus(targetFilePath);
		return "completed";
	}
	return "nothing-to-do";
}

/**
 * TM参照を検索してフォーマット済み文字列とマッチ情報を返す。
 * tm.enabledがfalseまたはTMXファイルが存在しない場合はundefinedを返す。
 * @param sourceContent ソースユニットの本文
 * @param sourceLang ソース言語コード
 * @param targetLang ターゲット言語コード
 * @returns フォーマット済み文字列とマッチ情報のオブジェクト、またはundefined
 */
export function lookupTmReferences(
	sourceContent: string,
	sourceLang: string,
	targetLang: string,
	oldSourceContent?: string,
): { formatted: string; matches: TmReferenceInfo[] } | undefined {
	const config = Configuration.getInstance();
	if (!config.getTmEnabled()) {
		return undefined;
	}

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return undefined;
	}

	const tmxFilePath = path.join(config.getMdaitDir(), "translations.tmx");

	const store = TmxStore.getInstance(tmxFilePath);
	if (store.getEntryCount() === 0) {
		return undefined;
	}

	// 行単位TM検索に委譲
	const matches = searchTmByLines(
		sourceContent,
		store,
		{
			minQueryLength: config.getTmMinQueryLength(),
			maxReferences: config.getTmMaxReferences(),
			sourceLang,
			targetLang,
			trigramCache: store.getTrigramCache(),
		},
		oldSourceContent,
	);

	if (matches.length === 0) {
		return undefined;
	}

	return {
		formatted: formatTmReferences(matches),
		matches: matches.map((m) => ({
			source: m.source,
			target: m.target,
			firstUsedIn: m.firstUsedIn,
		})),
	};
}
