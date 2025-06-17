import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusCollector } from "./status-collector";
import type { FileStatus, StatusItem, StatusType } from "./status-item";

/**
 * ステータスツリービューのデータプロバイダ
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<StatusItem | undefined | null> =
		new vscode.EventEmitter<StatusItem | undefined | null>();
	readonly onDidChangeTreeData: vscode.Event<StatusItem | undefined | null> =
		this._onDidChangeTreeData.event;

	private readonly statusCollector: StatusCollector;
	private readonly configuration: Configuration;
	private fileStatuses: FileStatus[] = [];

	constructor() {
		this.statusCollector = new StatusCollector();
		this.configuration = new Configuration();
	}

	/**
	 * ツリーデータをリフレッシュする
	 */
	public async refresh(): Promise<void> {
		try {
			// 設定を読み込み
			await this.configuration.load();

			// 設定が有効かチェック
			const validationError = this.configuration.validate();
			if (validationError) {
				vscode.window.showWarningMessage(validationError);
				this.fileStatuses = [];
			} else {
				// ファイル状況を収集
				this.fileStatuses = await this.statusCollector.collectAllFileStatuses(this.configuration);
			} // ツリービューを更新
			this._onDidChangeTreeData.fire(undefined);
		} catch (error) {
			console.error("Error refreshing status tree:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error refreshing status tree: {0}", (error as Error).message),
			);
		}
	}

	/**
	 * ツリーアイテムを取得する
	 */
	public getTreeItem(element: StatusItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.label, element.collapsibleState);

		// アイコンを設定
		treeItem.iconPath = this.getStatusIcon(element.status);

		// ツールチップを設定
		treeItem.tooltip = this.getTooltip(element);

		// ファイルタイプの場合はコンテキストメニュー用のcontextValueを設定
		if (element.type === "file") {
			treeItem.contextValue = "file";
		}

		return treeItem;
	}

	/**
	 * 子要素を取得する
	 */
	public getChildren(element?: StatusItem): Thenable<StatusItem[]> {
		if (!element) {
			// ルート要素の場合はファイル一覧を返す
			return Promise.resolve(this.getFileItems());
		}

		// 現在の実装では子要素はサポートしない（後続チケットで実装）
		return Promise.resolve([]);
	}

	/**
	 * ファイル一覧のStatusItemを作成する
	 */
	private getFileItems(): StatusItem[] {
		return this.fileStatuses.map((fileStatus) => this.createFileStatusItem(fileStatus));
	}

	/**
	 * FileStatusからStatusItemを作成する
	 */
	private createFileStatusItem(fileStatus: FileStatus): StatusItem {
		const label = this.createFileLabel(fileStatus);

		return {
			type: "file",
			label,
			filePath: fileStatus.filePath,
			status: fileStatus.status,
			collapsibleState: vscode.TreeItemCollapsibleState.None, // 基本実装では展開不可
			tooltip: this.createFileTooltip(fileStatus),
		};
	}

	/**
	 * ファイル用のラベルを作成する
	 */
	private createFileLabel(fileStatus: FileStatus): string {
		if (fileStatus.hasParseError) {
			return `${fileStatus.fileName} ❌`;
		}

		// 基本実装では統計は表示しない（後続チケットで実装）
		return fileStatus.fileName;
	}

	/**
	 * ファイル用のツールチップを作成する
	 */
	private createFileTooltip(fileStatus: FileStatus): string {
		if (fileStatus.hasParseError) {
			return vscode.l10n.t(
				"Parse error in {0}: {1}",
				fileStatus.fileName,
				fileStatus.errorMessage || "Unknown error",
			);
		}

		return vscode.l10n.t(
			"{0}: {1}/{2} units translated",
			fileStatus.fileName,
			fileStatus.translatedUnits,
			fileStatus.totalUnits,
		);
	}

	/**
	 * ツールチップを取得する
	 */
	private getTooltip(element: StatusItem): string {
		if (element.tooltip) {
			return element.tooltip;
		}

		switch (element.status) {
			case "translated":
				return vscode.l10n.t("Translation completed");
			case "needsTranslation":
				return vscode.l10n.t("Translation needed");
			case "error":
				return vscode.l10n.t("Error occurred");
			default:
				return vscode.l10n.t("Unknown status");
		}
	}

	/**
	 * ステータスに応じたアイコンを取得する
	 */
	private getStatusIcon(status: StatusType): vscode.ThemeIcon {
		switch (status) {
			case "translated":
				return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
			case "needsTranslation":
				return new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.yellow"));
			case "error":
				return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
			default:
				return new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.gray"));
		}
	}
}
