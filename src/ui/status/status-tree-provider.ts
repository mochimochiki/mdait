import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusManager } from "../../core/status-manager";
import { StatusItemType } from "./status-item";
import type { StatusItem, StatusType } from "./status-item";

/**
 * StatusTreeProviderの最小限のインターフェース（StatusManagerとの連携用）
 */
export interface IStatusTreeProvider {
	setFileStatuses(statuses: StatusItem[]): void;
	refreshFromStatusManager(): void;
}

/**
 * ステータスツリービューのデータプロバイダ
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem>, IStatusTreeProvider {
	private _onDidChangeTreeData: vscode.EventEmitter<StatusItem | undefined | null> =
		new vscode.EventEmitter<StatusItem | undefined | null>();
	readonly onDidChangeTreeData: vscode.Event<StatusItem | undefined | null> =
		this._onDidChangeTreeData.event;

	private readonly statusManager: StatusManager;
	private readonly configuration: Configuration;
	private fileStatuses: StatusItem[] = [];

	// ステータス初期化済みフラグと排他制御
	private isStatusInitialized = false;
	private isStatusLoading = false;

	constructor() {
		this.statusManager = StatusManager.getInstance();
		this.configuration = new Configuration();
	}

	/**
	 * ツリーデータをリフレッシュする
	 * @param item 更新したいStatusItem（省略時は全体）
	 */
	public async refresh(item?: StatusItem): Promise<void> {
		try {
			if (!item) {
				// 設定を読み込み
				await this.configuration.load();
				// 設定が有効かチェック
				const validationError = this.configuration.validate();
				if (validationError) {
					vscode.window.showWarningMessage(validationError);
					this.fileStatuses = [];
				} else {
					// StatusManagerから最新のStatusItemを取得
					if (this.statusManager.isStatusInitialized()) {
						this.fileStatuses = this.statusManager.getStatusItems();
					} else {
						// 初期化されていない場合は全体再構築
						this.fileStatuses = await this.statusManager.rebuildStatusItemAll(this.configuration);
					}
				}
				// ツリービューを全体更新
				this._onDidChangeTreeData.fire(undefined);
			} else {
				// 指定ノードのみ更新
				this._onDidChangeTreeData.fire(item);
			}
		} catch (error) {
			console.error("Error refreshing status tree:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error refreshing status tree: {0}", (error as Error).message),
			);
		}
	}

	/**
	 * API: ツリーアイテムを取得する
	 *
	 */
	public getTreeItem(element: StatusItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.label, element.collapsibleState);

		// ステータスに応じたアイコンを設定
		treeItem.iconPath = this.getStatusIcon(element.status, element.isTranslating);

		// ツールチップを設定
		treeItem.tooltip = this.getTooltip(element);

		// contextValueを設定（StatusItemから）
		treeItem.contextValue = element.contextValue;

		// idを設定
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (element.type === StatusItemType.Directory && element.directoryPath) {
			if (workspaceFolder) {
				treeItem.id = path.relative(workspaceFolder, element.directoryPath);
			} else {
				treeItem.id = element.directoryPath;
			}
		} else if (element.type === StatusItemType.File && element.filePath) {
			if (workspaceFolder) {
				treeItem.id = path.relative(workspaceFolder, element.filePath);
			} else {
				treeItem.id = element.filePath;
			}
		} else if (element.type === StatusItemType.Unit && element.filePath && element.unitHash) {
			if (workspaceFolder) {
				treeItem.id = `${path.relative(workspaceFolder, element.filePath)}#${element.unitHash}`;
			} else {
				treeItem.id = `${element.filePath}#${element.unitHash}`;
			}
		}

		// ファイルの場合はコマンドを設定してクリック時にファイルを開く（先頭行）
		if (element.type === StatusItemType.File) {
			treeItem.command = {
				command: "mdait.jumpToUnit",
				title: "Open File",
				arguments: [element.filePath, 0],
			};
		}
		// ユニットの場合はコマンドを設定してクリック時にジャンプ
		if (element.type === StatusItemType.Unit) {
			treeItem.command = {
				command: "mdait.jumpToUnit",
				title: "Jump to Unit",
				arguments: [element.filePath, element.startLine],
			};
		}

		return treeItem;
	}

	/**
	 * API: 子要素を取得する
	 * ユーザーがツリービューを開くと、getChildrenメソッドが`element`なしで呼び出されます
	 */
	public async getChildren(element?: StatusItem): Promise<StatusItem[]> {
		if (!this.isStatusInitialized && !this.isStatusLoading) {
			this.isStatusLoading = true;
			try {
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceFolder) {
					await this.configuration.load();
					// StatusManagerから最新のStatusItemを取得
					if (this.statusManager.isStatusInitialized()) {
						this.fileStatuses = this.statusManager.getStatusItems();
					} else {
						// 初期化されていない場合は全体再構築
						this.fileStatuses = await this.statusManager.rebuildStatusItemAll(this.configuration);
					}
				}
				this.isStatusInitialized = true;
			} catch (e) {
				console.warn("ステータス初期化に失敗", e);
			} finally {
				this.isStatusLoading = false;
			}
		}
		if (!element) {
			// ルート要素の場合はディレクトリ一覧を返す
			return Promise.resolve(this.getRootDirectoryItems());
		}
		if (element.type === StatusItemType.Directory) {
			// ディレクトリの場合はファイル一覧を返す
			return Promise.resolve(this.getStatusItemsRecursive(element.directoryPath));
		}
		if (element.type === StatusItemType.File) {
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
		const directoryMap = new Map<string, StatusItem[]>();
		// transPairs.targetDirの絶対パス一覧を作成
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const targetDirsAbs = this.configuration.transPairs.map((pair) =>
			workspaceFolder ? path.resolve(workspaceFolder, pair.targetDir) : pair.targetDir,
		);
		// ファイルをディレクトリごとにグループ化（targetDir一致のみ）
		for (const fileStatus of this.fileStatuses) {
			const dirPath = path.dirname(fileStatus.filePath ?? "");
			if (!targetDirsAbs.includes(dirPath)) {
				continue;
			}
			if (!directoryMap.has(dirPath)) {
				directoryMap.set(dirPath, []);
			}
			directoryMap.get(dirPath)?.push(fileStatus);
		}

		// ディレクトリごとにStatusItemを作成
		const directoryItems: StatusItem[] = [];
		for (const [dirPath, files] of directoryMap) {
			const dirName = path.basename(dirPath) || dirPath;
			const totalUnits = files.reduce((sum, file) => sum + (file.totalUnits ?? 0), 0);
			const translatedUnits = files.reduce((sum, file) => sum + (file.translatedUnits ?? 0), 0);

			// ディレクトリの全体ステータスを決定
			const status = this.determineDirectoryStatus(files);
			directoryItems.push({
				type: StatusItemType.Directory,
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
	private getStatusItemsRecursive(directoryPath?: string): StatusItem[] {
		const items: StatusItem[] = [];
		const subDirSet = new Set<string>();

		// 指定ディレクトリ配下のファイルを抽出
		const filesInDir = this.fileStatuses.filter((fileStatus) => {
			const dir = path.dirname(fileStatus.filePath ?? "");
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
			items.push(fileStatus);
		}

		// サブディレクトリを抽出
		for (const fileStatus of this.fileStatuses) {
			const dir = path.dirname(fileStatus.filePath ?? "");
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
				path.dirname(fs.filePath ?? "").startsWith(subDirPath),
			);
			const dirName = path.basename(subDirPath) || subDirPath;
			const totalUnits = files.reduce((sum, file) => sum + (file.totalUnits ?? 0), 0);
			const translatedUnits = files.reduce((sum, file) => sum + (file.translatedUnits ?? 0), 0);
			const status = this.determineDirectoryStatus(files);

			items.push({
				type: StatusItemType.Directory,
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
			...Array.from(items).filter((item) => item.type === StatusItemType.Directory),
			...Array.from(items).filter((item) => item.type === StatusItemType.File),
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
		if (!fileStatus || !fileStatus.children) {
			return [];
		}

		return fileStatus.children;
	}

	/**
	 * ディレクトリの全体ステータスを決定する
	 */
	private determineDirectoryStatus(files: StatusItem[]): StatusType {
		if (files.length === 0) return "unknown";

		const hasError = files.some((f) => f.status === "error");
		if (hasError) return "error";

		const totalUnits = files.reduce((sum, f) => sum + (f.totalUnits ?? 0), 0);
		const translatedUnits = files.reduce((sum, f) => sum + (f.translatedUnits ?? 0), 0);

		if (totalUnits === 0) return "unknown";
		if (translatedUnits === totalUnits) return "translated";
		return "needsTranslation";
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
	private getStatusIcon(status: StatusType, isProgress?: boolean): vscode.ThemeIcon {
		if (isProgress) {
			return new vscode.ThemeIcon("sync~spin");
		}
		switch (status) {
			case "translated":
				return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
			case "needsTranslation":
				return new vscode.ThemeIcon("circle");
			case "error":
				return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
			default:
				return new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.gray"));
		}
	}

	/**
	 * StatusManagerからStatusItemを設定
	 * StatusManagerによる一元管理のため
	 */
	public setFileStatuses(fileStatuses: StatusItem[]): void {
		this.fileStatuses = fileStatuses;
		this.isStatusInitialized = true;
	}

	/**
	 * StatusManagerからの更新通知を受けてツリーを更新
	 */
	public refreshFromStatusManager(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
