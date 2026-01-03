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
 * ディレクトリ、ファイル、ユニットを区別する
 */
export enum StatusItemType {
	Directory = "directory",
	File = "file",
	Unit = "unit",
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
	collapsibleState?: vscode.TreeItemCollapsibleState;
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
 * mdaitで管理するステータス項目1つを表す。
 * ディレクトリ・ファイル・ユニットを一元管理する統合型（Discriminated Union）
 */
export type StatusItem = DirectoryStatusItem | FileStatusItem | UnitStatusItem;

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
