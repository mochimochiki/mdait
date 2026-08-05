import type * as vscode from "vscode";
import type { FileStatusItem } from "../../core/status/status-item";
import type { TransPair } from "../../infra/config/configuration";
import type { SectionAligner } from "../adopt/section-aligner";
import type { DeclareIsolateResult } from "../markers/declare-isolate";
import type { DeleteUnitResult, DeleteUnitsResult } from "../markers/delete-unit";
import type { KeepUnitsResult } from "../markers/keep-unit";
import type { NeedResolutionOptions, NeedTarget, ResolveNeedFileResult } from "../markers/resolve-need";
import type { Translator } from "../trans/translator";
import type { FileType } from "./file-type";

export type {
	NeedResolutionOptions,
	NeedTarget,
	ResolveNeedFileResult,
} from "../markers/resolve-need";

/** ファイルタイプ識別子（定義は file-type.ts が持つ） */
export type { FileType };

/** sync結果（MdaitUnit非依存の簡潔な型） */
export interface FileSyncResult {
	added: number;
	modified: number;
	deleted: number;
	unchanged: number;
	revisionsNeeded: number;
	/** adoptで採用（need:review付与）したユニット数 */
	adopted?: number;
	/** 独立ユニットとして保持している孤立ターゲット数 */
	kept?: number;
	/** need:review を一次受け付与したマーカーなし孤立ターゲット数 */
	orphanReviewed?: number;
	/** 崩れを疑って自動削除を見送り、確認待ちにした孤立ターゲット数 */
	orphanDeletionWithheld?: number;
	/** AIアラインが適用した修正提案数 */
	alignCorrections?: number;
	/** 原文が空になったため訳文に触れずに中止したファイル数（0 or 1） */
	sourceEmptied?: number;
}

/** syncのオプション（コマンド層のSyncCommandOptionsと同義。循環依存回避のためここで定義） */
export interface FileSyncOptions {
	/** 採用（adopt）モード: マーカーなし・本文ありの既存訳文を need:review で採用する */
	adopt?: boolean;
	/** AIアライン: adopt 時の位置ベース対応付けを AI で差分審査する（明示指定時のみ） */
	align?: boolean;
}

/** translate結果 */
export interface FileTranslateResult {
	translatedCount: number;
	patchedCount: number;
	skippedCount: number;
	tmHits: number;
}

/** ファイルタイプ別の翻訳処理を統一的に扱うインターフェース */
export interface FileHandler {
	readonly fileType: FileType;

	/** 既存ターゲットとの同期（aligner は adopt+align 時のみ MD ハンドラが使用） */
	sync(
		sourceFile: string,
		targetFile: string,
		options?: FileSyncOptions,
		aligner?: SectionAligner,
	): Promise<FileSyncResult>;

	/** 新規ターゲット作成 */
	syncNew(sourceFile: string, targetFile: string): Promise<FileSyncResult>;

	/** ターゲットファイルの翻訳 */
	translate(
		targetFilePath: string,
		translator: Translator,
		pair: TransPair,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
	): Promise<FileTranslateResult | undefined>;

	/** ステータス収集 */
	collectStatus(filePath: string): Promise<FileStatusItem>;

	/** mdait管理下にあるか（マーカー or unit-state登録あり） */
	isInitialized(filePath: string): Promise<boolean>;

	// ===== マーカー／ユニット状態の書き換え =====
	// CodeLens・ツリー・LM Tool はこの3メソッドだけを呼ぶ。サーフェス側でマーカーを
	// 直接書き換えてはならない（排他制御・ステータス更新の取りこぼしが起きるため。
	// 詳細は commands/markers/unit-mutation.ts）。

	/** need フラグを外す（裁定の確定）。対象未指定なら needs フィルタに一致する全件 */
	resolveNeed(filePath: string, options?: NeedResolutionOptions): Promise<ResolveNeedFileResult>;

	/** 凍結を宣言する（need:isolate）。対応しないファイル種別では reason つきで false を返す */
	declareIsolate(filePath: string, target: NeedTarget): Promise<DeclareIsolateResult>;

	/** verify-deletion のユニットを削除する。対応しないファイル種別では reason つきで false を返す */
	deleteUnit(filePath: string, target: NeedTarget): Promise<DeleteUnitResult>;

	/**
	 * verify-deletion のユニットを独立ユニットとして残す（Keep の恒久化。need と from を同時に外す）。
	 * need を外すだけの resolveNeed では次の sync で確認待ちが復活するため、Keep はこちらを使う。
	 * hashes 省略時はファイル内の全 verify-deletion ユニットが対象（一括確定）。
	 */
	keepUnits(filePath: string, hashes?: string[]): Promise<KeepUnitsResult>;

	/** ファイル内の全 verify-deletion ユニットを1回の排他で削除する（一括確定） */
	deleteAllVerifyDeletion(filePath: string): Promise<DeleteUnitsResult>;
}
