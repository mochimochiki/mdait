import type * as vscode from "vscode";
import type { FileStatusItem } from "../../core/status/status-item";
import type { TransPair } from "../../infra/config/configuration";
import type { Translator } from "../trans/translator";

/** ファイルタイプ識別子 */
export type FileType = "md" | "plain";

/** sync結果（MdaitUnit非依存の簡潔な型） */
export interface FileSyncResult {
	added: number;
	modified: number;
	deleted: number;
	unchanged: number;
	revisionsNeeded: number;
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

	/** 既存ターゲットとの同期 */
	sync(sourceFile: string, targetFile: string): Promise<FileSyncResult>;

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
}
