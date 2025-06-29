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
	type: StatusItemType;

	/**
	 * 表示ラベル
	 */
	label: string;

	/**
	 * ディレクトリパス（ディレクトリタイプの場合）
	 */
	directoryPath?: string;

	/**
	 * ファイルパス（ファイル・ユニットタイプの場合）
	 */
	filePath?: string;

	/**
	 * 翻訳単位のハッシュ（ユニットタイプの場合）
	 */
	unitHash?: string;

	/**
	 * 開始行番号（ユニットタイプの場合、0ベース）
	 */
	startLine?: number;

	/**
	 * 終了行番号（ユニットタイプの場合、0ベース）
	 */
	endLine?: number;

	/**
	 * 翻訳状態
	 */
	status: StatusType;

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

	/**
	 * VS Codeのコンテキストメニューやインラインアクション用の識別子
	 */
	contextValue?: string;

	/**
	 * transコマンド進行中かどうか
	 */
	isTranslating?: boolean;
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

	/**
	 * ファイル内の翻訳ユニット詳細情報
	 */
	units?: UnitStatus[];
}

/**
 * 翻訳単位レベルのステータス情報
 */
export interface UnitStatus {
	/**
	 * 翻訳単位のハッシュ
	 */
	hash: string;

	/**
	 * 翻訳単位のタイトル（見出し）
	 */
	title: string;

	/**
	 * 見出しレベル
	 */
	headingLevel: number;

	/**
	 * 翻訳状態
	 */
	status: StatusType;

	/**
	 * 開始行番号（0ベース）
	 */
	startLine: number;

	/**
	 * 終了行番号（0ベース）
	 */
	endLine: number;

	/**
	 * 翻訳元ユニットのハッシュ
	 */
	fromHash?: string;

	/**
	 * needフラグ
	 */
	needFlag?: string;
}

export enum StatusItemType {
	Directory = "directory",
	File = "file",
	Unit = "unit",
}
