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

		// contextValueを設定（StatusItemから）
		treeItem.contextValue = element.contextValue;

		// ユニットの場合はコマンドを設定してクリック時にジャンプ
		if (element.type === "unit") {
			treeItem.command = {
				command: "mdait.jumpToUnit",
				title: "Jump to Unit",
				arguments: [element.filePath, element.startLine],
			};
		}

		return treeItem;
	}

	/**
	 * 子要素を取得する
	 */
	public getChildren(element?: StatusItem): Thenable<StatusItem[]> {
		if (!element) {
			// ルート要素の場合はディレクトリ一覧を返す
			return Promise.resolve(this.getRootDirectoryItems());
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
	private getRootDirectoryItems(): StatusItem[] {
		const directoryMap = new Map<string, FileStatus[]>();
		// transPairs.targetDirの絶対パス一覧を作成
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const targetDirsAbs = this.configuration.transPairs.map((pair) =>
			workspaceFolder ? path.resolve(workspaceFolder, pair.targetDir) : pair.targetDir,
		);
		// ファイルをディレクトリごとにグループ化（targetDir一致のみ）
		for (const fileStatus of this.fileStatuses) {
			const dirPath = path.dirname(fileStatus.filePath);
			if (!targetDirsAbs.includes(dirPath)) {
				continue;
			}
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
				contextValue: "mdaitDirectory",
			});
		}

		return directoryItems;
	}

	/**
	 * 指定ディレクトリのファイル・サブディレクトリ一覧のStatusItemを作成する
	 */
	private getFileItems(directoryPath?: string): StatusItem[] {
		const items: StatusItem[] = [];
		const subDirSet = new Set<string>();

		// 指定ディレクトリ配下のファイルを抽出
		const filesInDir = this.fileStatuses.filter((fileStatus) => {
			const dir = path.dirname(fileStatus.filePath);
			// directoryPathが未指定の場合はルート直下
			if (!directoryPath) {
				// ルート直下のファイルのみ
				const rel = path.relative("", dir);
				return rel === "" || rel === "." || dir === "" || dir === ".";
			}
			// 指定ディレクトリ直下のファイル
			return dir === directoryPath;
		});

		// ファイルStatusItemを追加
		for (const fileStatus of filesInDir) {
			items.push(this.createFileStatusItem(fileStatus));
		}

		// サブディレクトリを抽出
		for (const fileStatus of this.fileStatuses) {
			const dir = path.dirname(fileStatus.filePath);
			const parentDir = directoryPath ?? "";
			// サブディレクトリかどうか判定
			if (dir !== parentDir && dir.startsWith(parentDir)) {
				// 直下のサブディレクトリ名を取得
				const rel = path.relative(parentDir, dir);
				const parts = rel.split(path.sep);
				if (parts.length > 0 && parts[0] !== "" && parts[0] !== ".") {
					const subDirPath = path.join(parentDir, parts[0]);
					subDirSet.add(subDirPath);
				}
			}
		}

		// サブディレクトリStatusItemを追加
		for (const subDirPath of subDirSet) {
			const files = this.fileStatuses.filter((fs) =>
				path.dirname(fs.filePath).startsWith(subDirPath),
			);
			const dirName = path.basename(subDirPath) || subDirPath;
			const totalUnits = files.reduce((sum, file) => sum + file.totalUnits, 0);
			const translatedUnits = files.reduce((sum, file) => sum + file.translatedUnits, 0);
			const status = this.determineDirectoryStatus(files);

			items.push({
				type: "directory",
				label: `${dirName} (${translatedUnits}/${totalUnits})`,
				directoryPath: subDirPath,
				status,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				tooltip: vscode.l10n.t(
					"Directory: {0} - {1}/{2} units translated",
					dirName,
					translatedUnits,
					totalUnits,
				),
				contextValue: "mdaitDirectory",
			});
		}

		// ディレクトリ→ファイルの順で表示
		return [
			...Array.from(items).filter((item) => item.type === "directory"),
			...Array.from(items).filter((item) => item.type === "file"),
		];
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
			contextValue: "mdaitUnit",
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
			contextValue: "mdaitFile",
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
