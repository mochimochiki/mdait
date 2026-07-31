import type * as vscode from "vscode";

/**
 * ステータス
 */
export enum Status {
	Translated = "translated",
	NeedsTranslation = "needsTranslation",
	Error = "error",
	Unknown = "unknown",
	Source = "source",
	Empty = "empty",
}

/**
 * ディレクトリ、ファイル、ユニット、Frontmatterを区別する
 */
export enum StatusItemType {
	Directory = "directory",
	File = "file",
	Unit = "unit",
	Frontmatter = "frontmatter",
}

/**
 * StatusItemの共通プロパティ
 */
interface BaseStatusItem {
	/**
	 * 表示ラベル
	 */
	label: string;

	/**
	 * ステータス
	 */
	status: Status;

	// UI用
	iconPath?: vscode.ThemeIcon;
	tooltip?: string;
	contextValue?: string;
	isTranslating?: boolean;

	/**
	 * ラベルの右に薄字で添える副題（TreeItem.description）。
	 * 要対応キューでファイル名と種類を示すなど、ラベルだけでは項目を識別できない場合に使う。
	 */
	description?: string;

	/**
	 * StatusTree の集約仮想ノード（Needs Attention 等）に表示するクローンであることを示す。
	 * 実体（実ファイル配下の本体）と区別するため tree item id にサフィックスを付与する用途のみに使う。
	 */
	isVirtualCopy?: boolean;
}

/**
 * ディレクトリ用ステータス項目
 */
export interface DirectoryStatusItem extends BaseStatusItem {
	type: StatusItemType.Directory;
	directoryPath: string;
	children?: StatusItem[];
	// 集計用（互換性維持）
	translatedUnits?: number;
	totalUnits?: number;
}

/**
 * ファイル用ステータス項目
 */
export interface FileStatusItem extends BaseStatusItem {
	type: StatusItemType.File;
	filePath: string;
	fileName: string;
	translatedUnits: number;
	totalUnits: number;
	hasParseError?: boolean;
	errorMessage?: string;
	children?: UnitStatusItem[];
	frontmatter?: FrontmatterStatusItem;
}

/**
 * ユニット用ステータス項目
 */
export interface UnitStatusItem extends BaseStatusItem {
	type: StatusItemType.Unit;
	filePath: string; // 親ファイルパス（必須）
	fileName?: string; // 互換性維持用
	unitHash: string;
	title?: string;
	headingLevel?: number;
	fromHash?: string;
	needFlag?: string;
	startLine?: number;
	endLine?: number;
	errorMessage?: string; // エラー発生時のメッセージ
}

/**
 * Frontmatter用ステータス項目
 */
export interface FrontmatterStatusItem extends BaseStatusItem {
	type: StatusItemType.Frontmatter;
	filePath: string; // 親ファイルパス（必須）
	fileName: string;
	fromHash?: string;
	needFlag?: string;
}

/**
 * mdaitで管理するステータス項目1つを表す。
 * ディレクトリ・ファイル・ユニット・Frontmatterを一元管理する統合型（Discriminated Union）
 */
export type StatusItem = DirectoryStatusItem | FileStatusItem | UnitStatusItem | FrontmatterStatusItem;

// ========== need フラグの分類 ==========

/**
 * ユニットが凍結宣言されているか（`need:isolate`）。
 *
 * 凍結は「作業待ち」ではなく恒久的な宣言である。sync は凍結ユニットの上に
 * revise / translate / verify-deletion を書かない（sync-command.ts の suppressNeed、
 * section-matcher.ts のパススルー保持）ため、宣言は解除されるまで残り続ける。
 */
export function isIsolatedNeed(need: string | null | undefined): boolean {
	return need === "isolate";
}

/**
 * need フラグが「人間または AI の作業待ち」を表すか。
 * 凍結宣言は作業待ちではないため false を返す。
 */
export function isPendingWorkNeed(need: string | null | undefined): boolean {
	return !!need && !isIsolatedNeed(need);
}

/**
 * trans コマンドが自動で処理できる翻訳待ちの need（`translate` / `revise@…`）か。
 * 人間の判断待ち（review / verify-deletion）や凍結宣言（isolate）は含まない。
 * sync 完了通知の「翻訳待ち件数」など、「今すぐ翻訳」導線の対象を数えるときに使う。
 */
export function isTranslateNeed(need: string | null | undefined): boolean {
	return need === "translate" || (need?.startsWith("revise@") ?? false);
}

/**
 * 翻訳率の分母・分子に数えるユニットか。
 *
 * `Status` にこの判定を持たせてはならない。以前は凍結ユニットを分母から外すために
 * `Status.Source` を名乗らせていたが、`Status` は「原文側か訳文側か」も表すため、
 * それを先に見ていた contextValue の分岐が巻き添えで壊れた（到達不能な分岐が生まれた）。
 * 「数えるか」は Status とは独立した質問として、この述語だけが答える。
 */
export function isCountedInProgress(unit: UnitStatusItem): boolean {
	return unit.status !== Status.Source && !isIsolatedNeed(unit.needFlag);
}

// ========== 型ガードヘルパー関数 ==========

/**
 * DirectoryStatusItemかどうかを判定する型ガード
 */
export function isDirectoryStatusItem(item: StatusItem): item is DirectoryStatusItem {
	return item.type === StatusItemType.Directory;
}

/**
 * FileStatusItemかどうかを判定する型ガード
 */
export function isFileStatusItem(item: StatusItem): item is FileStatusItem {
	return item.type === StatusItemType.File;
}

/**
 * UnitStatusItemかどうかを判定する型ガード
 */
export function isUnitStatusItem(item: StatusItem): item is UnitStatusItem {
	return item.type === StatusItemType.Unit;
}

/**
 * FrontmatterStatusItemかどうかを判定する型ガード
 */
export function isFrontmatterStatusItem(item: StatusItem): item is FrontmatterStatusItem {
	return item.type === StatusItemType.Frontmatter;
}

/**
 * FileStatusItemからUnit子要素のみを取得する
 * @param fileItem ファイルステータス項目
 * @returns ユニットステータス項目の配列
 */
export function getUnitsFromFile(fileItem: FileStatusItem): UnitStatusItem[] {
	return fileItem.children ?? [];
}
