import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { Status, type StatusItem, StatusItemType } from "../../core/status/status-item";
import { type IStatusTreeProvider, StatusManager } from "../../core/status/status-manager";

/**
 * ステータスツリービューのデータプロバイダ
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem>, IStatusTreeProvider {
	private _onDidChangeTreeData: vscode.EventEmitter<StatusItem | undefined | null> = new vscode.EventEmitter<
		StatusItem | undefined | null
	>();
	readonly onDidChangeTreeData: vscode.Event<StatusItem | undefined | null> = this._onDidChangeTreeData.event;

	private readonly statusManager: StatusManager;
	private readonly configuration: Configuration;
	private statusItemTree: StatusItem[] = [];

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
					this.statusItemTree = [];
				} else {
					// StatusManagerから最新のStatusItemを取得
					if (this.statusManager.isInitialized()) {
						this.statusItemTree = this.statusManager.getStatusItemTree();
					} else {
						// 初期化されていない場合は全体再構築
						this.statusItemTree = await this.statusManager.buildAllStatusItem(this.configuration);
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
			vscode.window.showErrorMessage(vscode.l10n.t("Error refreshing status tree: {0}", (error as Error).message));
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
					if (this.statusManager.isInitialized()) {
						this.statusItemTree = this.statusManager.getStatusItemTree();
					} else {
						// 初期化されていない場合は全体再構築
						this.statusItemTree = await this.statusManager.buildAllStatusItem(this.configuration);
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
		// transPairs.targetDirとsourceDirの絶対パス一覧を作成
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const allDirsAbs = this.configuration.transPairs.flatMap((pair) => [
			workspaceFolder ? path.resolve(workspaceFolder, pair.sourceDir) : pair.sourceDir,
			workspaceFolder ? path.resolve(workspaceFolder, pair.targetDir) : pair.targetDir,
		]);
		// ファイルをディレクトリごとにグループ化（sourceDir/targetDir一致のみ）
		for (const fileStatus of this.statusItemTree) {
			const dirPath = path.dirname(fileStatus.filePath ?? "");
			if (!allDirsAbs.includes(dirPath)) {
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

			// sourceディレクトリの場合は翻訳ユニット数を表示しない
			const label = status === Status.Source ? dirName : `${dirName} (${translatedUnits}/${totalUnits})`;
			const tooltip =
				status === Status.Source
					? vscode.l10n.t("Source directory: {0}", dirName)
					: vscode.l10n.t("Directory: {0} - {1}/{2} units translated", dirName, translatedUnits, totalUnits);

			directoryItems.push({
				type: StatusItemType.Directory,
				label,
				directoryPath: dirPath,
				status,
				collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
				tooltip,
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
		const filesInDir = this.statusItemTree.filter((fileStatus) => {
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
		for (const fileStatus of this.statusItemTree) {
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
			const files = this.statusItemTree.filter((fs) => path.dirname(fs.filePath ?? "").startsWith(subDirPath));
			const dirName = path.basename(subDirPath) || subDirPath;
			const totalUnits = files.reduce((sum, file) => sum + (file.totalUnits ?? 0), 0);
			const translatedUnits = files.reduce((sum, file) => sum + (file.translatedUnits ?? 0), 0);
			const status = this.determineDirectoryStatus(files);

			// sourceディレクトリの場合は翻訳ユニット数を表示しない
			const label = status === Status.Source ? dirName : `${dirName} (${translatedUnits}/${totalUnits})`;
			const tooltip =
				status === Status.Source
					? vscode.l10n.t("Source directory: {0}", dirName)
					: vscode.l10n.t("Directory: {0} - {1}/{2} units translated", dirName, translatedUnits, totalUnits);

			items.push({
				type: StatusItemType.Directory,
				label,
				directoryPath: subDirPath,
				status,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				tooltip,
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

		const fileStatus = this.statusItemTree.find((fs) => fs.filePath === filePath);
		if (!fileStatus || !fileStatus.children) {
			return [];
		}

		return fileStatus.children;
	}

	/**
	 * ディレクトリの全体ステータスを決定する
	 */
	private determineDirectoryStatus(files: StatusItem[]): Status {
		if (files.length === 0) return Status.Unknown;

		const hasError = files.some((f) => f.status === Status.Error);
		if (hasError) return Status.Error;

		const allSource = files.every((f) => f.status === Status.Source);
		if (allSource) return Status.Source;

		const totalUnits = files.reduce((sum, f) => sum + (f.totalUnits ?? 0), 0);
		const translatedUnits = files.reduce((sum, f) => sum + (f.translatedUnits ?? 0), 0);

		if (totalUnits === 0) return Status.Unknown;
		if (translatedUnits === totalUnits) return Status.Translated;
		return Status.NeedsTranslation;
	}

	/**
	 * ツールチップを取得する
	 */
	private getTooltip(element: StatusItem): string {
		if (element.tooltip) {
			return element.tooltip;
		}

		switch (element.status) {
			case Status.Translated:
				return vscode.l10n.t("Translation completed");
			case Status.NeedsTranslation:
				return vscode.l10n.t("Translation needed");
			case Status.Source:
				return vscode.l10n.t("Source document");
			case Status.Error:
				return vscode.l10n.t("Error occurred");
			default:
				return vscode.l10n.t("Unknown status");
		}
	}

	/**
	 * ステータスに応じたアイコンを取得する
	 */
	private getStatusIcon(status: Status, isProgress?: boolean): vscode.ThemeIcon {
		if (isProgress) {
			return new vscode.ThemeIcon("sync~spin");
		}
		switch (status) {
			case Status.Translated:
				return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
			case Status.NeedsTranslation:
				return new vscode.ThemeIcon("circle");
			case Status.Source:
				return new vscode.ThemeIcon("symbol-constant", new vscode.ThemeColor("charts.blue"));
			case Status.Error:
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
		this.statusItemTree = fileStatuses;
		this.isStatusInitialized = true;
	}

	/**
	 * 特定ファイルのStatusItemを部分更新
	 * パフォーマンス改善とUI競合回避のため
	 */
	public updateFileStatus(filePath: string, updatedFileItem: StatusItem): void {
		const existingIndex = this.statusItemTree.findIndex(
			(item) => item.type === StatusItemType.File && item.filePath === filePath,
		);

		if (existingIndex >= 0) {
			// 既存ファイルアイテムを更新
			this.statusItemTree[existingIndex] = updatedFileItem;
		} else {
			// 新規ファイルアイテムを追加
			this.statusItemTree.push(updatedFileItem);
		}

		// 該当ファイルアイテムのみツリー更新
		this._onDidChangeTreeData.fire(updatedFileItem);
	}

	/**
	 * 特定ユニットのStatusItemを部分更新
	 * パフォーマンス改善とUI競合回避のため
	 */
	public updateUnitStatus(unitHash: string, updates: Partial<StatusItem>, filePath?: string): void {
		let updatedUnit: StatusItem | undefined;

		// ファイル内のユニットを検索・更新
		for (const fileItem of this.statusItemTree) {
			if (fileItem.type === StatusItemType.File) {
				// ファイルパス制約がある場合はチェック
				if (filePath && fileItem.filePath !== filePath) {
					continue;
				}

				if (fileItem.children) {
					for (const unit of fileItem.children) {
						if (unit.type === StatusItemType.Unit && unit.unitHash === unitHash) {
							// ユニットを部分更新
							Object.assign(unit, updates);
							updatedUnit = unit;

							// ファイルパス制約がある場合は最初の一致のみ更新
							if (filePath) {
								break;
							}
						}
					}
				}
			}
		}

		// 更新されたユニットのツリー表示を更新
		if (updatedUnit) {
			this._onDidChangeTreeData.fire(updatedUnit);
		}
	}

	/**
	 * StatusManagerからの更新通知を受けてツリーを更新
	 */
	public refreshFromStatusManager(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
