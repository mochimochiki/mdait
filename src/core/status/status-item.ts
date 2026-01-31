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
