import type * as vscode from "vscode";

/**
 * ツリービューアイテムの状態
 */
export type StatusType = "translated" | "needsTranslation" | "error" | "unknown";

/**
 * ツリービューアイテムのデータ構造
 */
export interface StatusItem {
	/**
	 * アイテムのタイプ
	 */
	type: "file" | "unit";

	/**
	 * 表示ラベル
	 */
	label: string;

	/**
	 * ファイルパス（ファイルタイプの場合）
	 */
	filePath?: string;

	/**
	 * 翻訳状態
	 */
	status: StatusType;

	/**
	 * 子アイテム（将来的にユニット詳細表示で使用）
	 */
	children?: StatusItem[];

	/**
	 * VS Codeツリーアイテムの状態
	 */
	collapsibleState?: vscode.TreeItemCollapsibleState;

	/**
	 * アイコンのテーマアイコン
	 */
	iconPath?: vscode.ThemeIcon;

	/**
	 * ツールチップテキスト
	 */
	tooltip?: string;
}

/**
 * ファイルレベルのステータス統計
 */
export interface FileStatus {
	/**
	 * ファイルパス
	 */
	filePath: string;

	/**
	 * ファイル名
	 */
	fileName: string;

	/**
	 * ファイル全体の状態
	 */
	status: StatusType;

	/**
	 * 翻訳済みユニット数
	 */
	translatedUnits: number;

	/**
	 * 全ユニット数
	 */
	totalUnits: number;

	/**
	 * パースエラーがあるかどうか
	 */
	hasParseError: boolean;

	/**
	 * エラーメッセージ
	 */
	errorMessage?: string;
}
