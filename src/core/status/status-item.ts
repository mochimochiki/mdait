import type * as vscode from "vscode";

/**
 * ステータス情報のタイプ
 */
export type StatusType = "translated" | "needsTranslation" | "error" | "unknown" | "source";

export enum StatusItemType {
	Directory = "directory",
	File = "file",
	Unit = "unit",
}

/**
 * ディレクトリ・ファイル・ユニットを一元管理する統合型
 */
export interface StatusItem {
	/**
	 * アイテムのタイプ
	 */
	type: StatusItemType;

	/**
	 * 表示ラベル
	 */
	label: string;

	/**
	 * 翻訳状態
	 */
	status: StatusType;

	// ディレクトリ用
	directoryPath?: string;

	// ファイル用
	filePath?: string;
	fileName?: string;
	translatedUnits?: number;
	totalUnits?: number;
	hasParseError?: boolean;
	errorMessage?: string;

	// ユニット用
	unitHash?: string;
	title?: string;
	headingLevel?: number;
	fromHash?: string;
	needFlag?: string;
	startLine?: number;
	endLine?: number;

	// 共通（ツリー構造）
	children?: StatusItem[];

	// UI用
	collapsibleState?: vscode.TreeItemCollapsibleState;
	iconPath?: vscode.ThemeIcon;
	tooltip?: string;
	contextValue?: string;
	isTranslating?: boolean;
}
