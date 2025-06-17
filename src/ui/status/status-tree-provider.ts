import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusCollector } from "./status-collector";
import type { FileStatus, StatusItem, StatusType, UnitStatus } from "./status-item";

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

		// タイプに応じてコンテキストメニュー用のcontextValueを設定
		if (element.type === "file") {
			treeItem.contextValue = "file";
		} else if (element.type === "unit") {
			treeItem.contextValue = "unit";
			// ユニットの場合はコマンドを設定してクリック時にジャンプ
			treeItem.command = {
				command: "mdait.jumpToUnit",
				title: "Jump to Unit",
				arguments: [element.filePath, element.startLine],
			};
		} else if (element.type === "directory") {
			treeItem.contextValue = "directory";
		}

		return treeItem;
	}

	/**
	 * 子要素を取得する
	 */
	public getChildren(element?: StatusItem): Thenable<StatusItem[]> {
		if (!element) {
			// ルート要素の場合はディレクトリ一覧を返す
			return Promise.resolve(this.getDirectoryItems());
		}

		if (element.type === "directory") {
			// ディレクトリの場合はファイル一覧を返す
			return Promise.resolve(this.getFileItems(element.directoryPath));
		}

		if (element.type === "file") {
			// ファイルの場合は翻訳ユニット一覧を返す
			return Promise.resolve(this.getUnitItems(element.filePath));
		}

		// ユニットタイプの場合は子要素なし
		return Promise.resolve([]);
	}

	/**
	 * ディレクトリ一覧のStatusItemを作成する
	 */
	private getDirectoryItems(): StatusItem[] {
		const directoryMap = new Map<string, FileStatus[]>();
		// ファイルをディレクトリごとにグループ化
		for (const fileStatus of this.fileStatuses) {
			const dirPath = path.dirname(fileStatus.filePath);
			if (!directoryMap.has(dirPath)) {
				directoryMap.set(dirPath, []);
			}
			const files = directoryMap.get(dirPath);
			if (files) {
				files.push(fileStatus);
			}
		}

		// ディレクトリごとにStatusItemを作成
		const directoryItems: StatusItem[] = [];
		for (const [dirPath, files] of directoryMap) {
			const dirName = path.basename(dirPath) || dirPath;
			const totalUnits = files.reduce((sum, file) => sum + file.totalUnits, 0);
			const translatedUnits = files.reduce((sum, file) => sum + file.translatedUnits, 0);

			// ディレクトリの全体ステータスを決定
			const status = this.determineDirectoryStatus(files);

			directoryItems.push({
				type: "directory",
				label: `${dirName} (${translatedUnits}/${totalUnits})`,
				directoryPath: dirPath,
				status,
				collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
				tooltip: vscode.l10n.t(
					"Directory: {0} - {1}/{2} units translated",
					dirName,
					translatedUnits,
					totalUnits,
				),
			});
		}

		return directoryItems;
	}

	/**
	 * 指定ディレクトリのファイル一覧のStatusItemを作成する
	 */
	private getFileItems(directoryPath?: string): StatusItem[] {
		if (!directoryPath) {
			return this.fileStatuses.map((fileStatus) => this.createFileStatusItem(fileStatus));
		}

		return this.fileStatuses
			.filter((fileStatus) => path.dirname(fileStatus.filePath) === directoryPath)
			.map((fileStatus) => this.createFileStatusItem(fileStatus));
	}

	/**
	 * 指定ファイルの翻訳ユニット一覧のStatusItemを作成する
	 */
	private getUnitItems(filePath?: string): StatusItem[] {
		if (!filePath) {
			return [];
		}

		const fileStatus = this.fileStatuses.find((fs) => fs.filePath === filePath);
		if (!fileStatus || !fileStatus.units) {
			return [];
		}

		return fileStatus.units.map((unit) => this.createUnitStatusItem(unit, filePath));
	}

	/**
	 * UnitStatusからStatusItemを作成する
	 */
	private createUnitStatusItem(unitStatus: UnitStatus, filePath: string): StatusItem {
		return {
			type: "unit",
			label: unitStatus.title || `Unit ${unitStatus.hash}`,
			filePath,
			unitHash: unitStatus.hash,
			startLine: unitStatus.startLine,
			endLine: unitStatus.endLine,
			status: unitStatus.status,
			collapsibleState: vscode.TreeItemCollapsibleState.None,
			tooltip: this.createUnitTooltip(unitStatus),
		};
	}

	/**
	 * ディレクトリの全体ステータスを決定する
	 */
	private determineDirectoryStatus(files: FileStatus[]): StatusType {
		if (files.length === 0) return "unknown";

		const hasError = files.some((f) => f.status === "error");
		if (hasError) return "error";

		const totalUnits = files.reduce((sum, f) => sum + f.totalUnits, 0);
		const translatedUnits = files.reduce((sum, f) => sum + f.translatedUnits, 0);

		if (totalUnits === 0) return "unknown";
		if (translatedUnits === totalUnits) return "translated";
		return "needsTranslation";
	}

	/**
	 * 翻訳ユニット用のツールチップを作成する
	 */
	private createUnitTooltip(unitStatus: UnitStatus): string {
		let tooltip = `${unitStatus.title} (${unitStatus.hash})`;

		if (unitStatus.needFlag) {
			tooltip += ` - Need: ${unitStatus.needFlag}`;
		}

		if (unitStatus.fromHash) {
			tooltip += ` - From: ${unitStatus.fromHash}`;
		}

		tooltip += ` - Lines: ${unitStatus.startLine + 1}-${unitStatus.endLine + 1}`;

		return tooltip;
	}
	/**
	 * ファイル一覧のStatusItemを作成する（廃止：getFileItems(directoryPath)に統合）
	 */
	private getOldFileItems(): StatusItem[] {
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
			collapsibleState:
				fileStatus.units && fileStatus.units.length > 0
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None,
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
