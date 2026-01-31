import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { SelectionState } from "../../core/status/selection-state";
import { Status, type StatusItem, StatusItemType, isFrontmatterStatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";

/**
 * ステータスツリービューのデータプロバイダ
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<StatusItem | undefined | null> = new vscode.EventEmitter<
		StatusItem | undefined | null
	>();
	readonly onDidChangeTreeData: vscode.Event<StatusItem | undefined | null> = this._onDidChangeTreeData.event;

	private readonly statusManager: StatusManager;
	private readonly configuration: Configuration;
	// StatusItemTreeへの直接アクセス用
	private get statusItemTree() {
		return this.statusManager.getStatusItemTree();
	}

	// ステータス初期化済みフラグと排他制御
	private isStatusInitialized = false;
	private isStatusLoading = false;

	constructor() {
		this.statusManager = StatusManager.getInstance();
		this.configuration = Configuration.getInstance();

		// Eventリスナーを登録
		this.statusManager.onStatusTreeChanged((updatedItem) => {
			if (updatedItem !== null) {
				// 該当ファイルアイテムのみツリー更新
				this._onDidChangeTreeData.fire(updatedItem);
			}
		});
	}

	/**
	 * 外部から手動更新したい場合に使用
	 */
	public refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * StatusItemのcollapsibleStateを動的に判定する
	 * VSCodeのTreeViewがUI状態を管理できるよう、getTreeItem呼び出し時に毎回子要素の有無で判定する
	 */
	private determineCollapsibleState(element: StatusItem): vscode.TreeItemCollapsibleState {
		switch (element.type) {
			case StatusItemType.Directory:
				// ディレクトリは子要素（ファイル・サブディレクトリ）があればCollapsed
				return this.statusItemTree.getDirectoryChildren(element.directoryPath).length > 0
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None;
			case StatusItemType.File:
				// ファイルは子要素（frontmatter + ユニット）があればCollapsed
				return this.getFileChildren(element).length > 0
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None;
			case StatusItemType.Unit:
			case StatusItemType.Frontmatter:
				// ユニット・Frontmatterは常に子要素なし
				return vscode.TreeItemCollapsibleState.None;
			default:
				return vscode.TreeItemCollapsibleState.None;
		}
	}

	/**
	 * アクティブなファイルに対応するツリーアイテムを展開・選択する
	 * @param filePath ファイルの絶対パス
	 * @param treeView TreeViewインスタンス
	 */
	public async revealActiveFile(filePath: string, treeView: vscode.TreeView<StatusItem>): Promise<void> {
		// 設定が完了していない、またはステータスが初期化されていない場合は何もしない
		if (!this.configuration.isConfigured() || !this.isStatusInitialized) {
			return;
		}

		// ビューが見えていない場合は何もしない
		if (!treeView.visible) {
			return;
		}

		try {
			// StatusItemTreeからファイルアイテムを取得
			const fileItem = this.statusItemTree.getFile(filePath);
			if (!fileItem) {
				// mdait管理対象外のファイル
				return;
			}

			// TreeViewでアイテムを選択
			// expandを指定しないことで、親階層のみ展開され、ファイルアイテム自身は展開されない
			await treeView.reveal(fileItem, {
				select: true,
				focus: false,
			});
		} catch (error) {
			// エラーが発生しても処理を中断しない（ログのみ出力）
			console.debug("Failed to reveal file in status tree:", error);
		}
	}

	/**
	 * API: ツリーアイテムを取得する
	 * elementはgetChildrenから渡されるStatusItemのため、インスタンスが入れ替わっていると古い状態になっている可能性がある
	 * 各StatusItem更新ではAssignを使用しているため、最新の状態を反映する
	 */
	public getTreeItem(element: StatusItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.label, this.determineCollapsibleState(element));

		// ステータスに応じたアイコンを設定
		treeItem.iconPath = this.getStatusIcon(element.status, element.isTranslating, element);

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
		} else if (element.type === StatusItemType.Frontmatter && element.filePath) {
			if (workspaceFolder) {
				treeItem.id = `${path.relative(workspaceFolder, element.filePath)}#frontmatter`;
			} else {
				treeItem.id = `${element.filePath}#frontmatter`;
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
		// frontmatterの場合はコマンドを設定してクリック時にファイル先頭にジャンプ
		if (element.type === StatusItemType.Frontmatter) {
			treeItem.command = {
				command: "mdait.jumpToUnit",
				title: "Jump to Frontmatter",
				arguments: [element.filePath, 0],
			};
		}

		return treeItem;
	}

	/**
	 * API: 親要素を取得する
	 * TreeView.reveal()を使用するために必要
	 */
	public getParent(element: StatusItem): StatusItem | undefined {
		// Unitの場合、親はFile
		if (element.type === StatusItemType.Unit && element.filePath) {
			return this.statusItemTree.getFile(element.filePath);
		}

		// Frontmatterの場合、親はFile
		if (element.type === StatusItemType.Frontmatter && element.filePath) {
			return this.statusItemTree.getFile(element.filePath);
		}

		// Fileの場合、親はDirectory
		if (element.type === StatusItemType.File && element.filePath) {
			const dirPath = path.dirname(element.filePath);
			return this.statusItemTree.getDirectory(dirPath);
		}

		// Directoryの場合、親は親Directory（ルートの場合はundefined）
		if (element.type === StatusItemType.Directory && element.directoryPath) {
			const parentPath = path.dirname(element.directoryPath);
			// ルートディレクトリの場合はundefinedを返す
			if (parentPath === element.directoryPath) {
				return undefined;
			}
			return this.statusItemTree.getDirectory(parentPath);
		}

		return undefined;
	}

	/**
	 * API: 子要素を取得する
	 * ユーザーがツリービューを開くと、getChildrenメソッドが`element`なしで呼び出されます
	 */
	public async getChildren(element?: StatusItem): Promise<StatusItem[]> {
		// 設定が完了していない場合は空配列を返す（Welcome Viewが表示される）
		if (!this.configuration.isConfigured()) {
			return [];
		}

		if (!this.isStatusInitialized && !this.isStatusLoading) {
			this.isStatusLoading = true;
			try {
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceFolder) {
					// StatusManagerから最新のStatusItemを取得・ツリーに反映
					if (!this.statusManager.isInitialized()) {
						// 初期化されていない場合は全体再構築
						await this.statusManager.buildStatusItemTree();
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
			// ファイルの場合はfrontmatter + 翻訳ユニット一覧を返す
			return Promise.resolve(this.getFileChildren(element));
		}
		// ユニットタイプ・Frontmatterタイプの場合は子要素なし
		return Promise.resolve([]);
	}

	/**
	 * ディレクトリ一覧のStatusItemを作成する
	 */
	private getRootDirectoryItems(): StatusItem[] {
		// 選択中の target のみに絞ってディレクトリ一覧を作成
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const pairs = SelectionState.getInstance().filterTransPairs(this.configuration.transPairs);
		const dirsAbs = Array.from(
			new Set(
				pairs.flatMap((pair) => [
					workspaceFolder ? path.resolve(workspaceFolder, pair.sourceDir) : pair.sourceDir,
					workspaceFolder ? path.resolve(workspaceFolder, pair.targetDir) : pair.targetDir,
				]),
			),
		);

		// StatusItemTreeからルートディレクトリアイテムを取得
		const items = this.statusItemTree.getRootDirectoryItems(dirsAbs);
		// Status.Emptyのアイテムを除外
		return items.filter((item) => item.status !== Status.Empty);
	}

	/**
	 * 指定ディレクトリのファイル・サブディレクトリ一覧のStatusItemを作成する
	 */
	private getStatusItemsRecursive(directoryPath?: string): StatusItem[] {
		if (!directoryPath) {
			return [];
		}

		// StatusItemTreeから子要素を取得
		const items = this.statusItemTree.getDirectoryChildren(directoryPath);
		// Status.Emptyのアイテムを除外
		return items.filter((item) => item.status !== Status.Empty);
	}

	/**
	 * 指定ファイルの子要素（frontmatter + ユニット）を返す
	 */
	private getFileChildren(fileItem: import("../../core/status/status-item").FileStatusItem): StatusItem[] {
		const children: StatusItem[] = [];

		// frontmatter項目があれば先頭に追加
		if (fileItem.frontmatter) {
			children.push(fileItem.frontmatter);
		}

		// ユニット一覧を追加（Status.Emptyを除外）
		const units = this.statusItemTree.getUnitsInFile(fileItem.filePath);
		for (const unit of units) {
			if (unit.status !== Status.Empty) {
				children.push(unit);
			}
		}

		return children;
	}

	/**
	 * ツールチップを取得する
	 */
	private getTooltip(element: StatusItem): string {
		if (element.tooltip) {
			return element.tooltip;
		}

		// ユニットのneedFlagを優先して表示
		if (element.type === StatusItemType.Unit && element.needFlag) {
			if (element.needFlag === "review") {
				return vscode.l10n.t("Review required");
			}
			if (element.needFlag.startsWith("revise@")) {
				return vscode.l10n.t("Translation needed");
			}
		}

		switch (element.status) {
			case Status.Translated:
				return vscode.l10n.t("Translation completed");
			case Status.NeedsTranslation:
				return vscode.l10n.t("Translation needed");
			case Status.Source:
				return vscode.l10n.t("Source document");
			case Status.Empty:
				return vscode.l10n.t("Empty content");
			case Status.Error:
				return vscode.l10n.t("Error occurred");
			default:
				return vscode.l10n.t("Unknown status");
		}
	}

	/**
	 * ステータスに応じたアイコンを取得する
	 */
	private getStatusIcon(status: Status, isProgress?: boolean, element?: StatusItem): vscode.ThemeIcon {
		if (isProgress) {
			return new vscode.ThemeIcon("sync~spin");
		}

		// Frontmatter階層の場合はbookアイコンを使用
		if (element?.type === StatusItemType.Frontmatter) {
			switch (status) {
				case Status.Translated:
					return new vscode.ThemeIcon("book", new vscode.ThemeColor("charts.green"));
				case Status.NeedsTranslation:
					return new vscode.ThemeIcon("book");
				case Status.Source:
					return new vscode.ThemeIcon("book", new vscode.ThemeColor("charts.blue"));
				default:
					return new vscode.ThemeIcon("book", new vscode.ThemeColor("charts.gray"));
			}
		}

		// ユニット階層の場合はcircle-smallアイコンを使用
		if (element?.type === StatusItemType.Unit) {
			// needFlagを優先してアイコンを決定
			if (element.needFlag) {
				if (element.needFlag === "review") {
					return new vscode.ThemeIcon("circle-small-filled", new vscode.ThemeColor("charts.yellow"));
				}
			}

			// ステータスに応じてアイコンを決定
			switch (status) {
				case Status.Translated:
					return new vscode.ThemeIcon("circle-small-filled", new vscode.ThemeColor("charts.green"));
				case Status.NeedsTranslation:
					return new vscode.ThemeIcon("circle-small");
				case Status.Source:
					return new vscode.ThemeIcon("circle-small-filled", new vscode.ThemeColor("charts.blue"));
				case Status.Empty:
					return new vscode.ThemeIcon("circle-small-filled", new vscode.ThemeColor("charts.yellow"));
				case Status.Error:
					return new vscode.ThemeIcon("circle-small-filled", new vscode.ThemeColor("charts.red"));
				default:
					return new vscode.ThemeIcon("circle-small", new vscode.ThemeColor("charts.gray"));
			}
		}

		// ファイル・ディレクトリ階層は従来のアイコンを使用
		switch (status) {
			case Status.Translated:
				return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
			case Status.NeedsTranslation:
				return new vscode.ThemeIcon("circle");
			case Status.Source:
				return new vscode.ThemeIcon("symbol-constant", new vscode.ThemeColor("charts.blue"));
			case Status.Empty:
				return new vscode.ThemeIcon("symbol-variable", new vscode.ThemeColor("charts.yellow"));
			case Status.Error:
				return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
			default:
				return new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.gray"));
		}
	}
}
