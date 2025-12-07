import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { SelectionState } from "../../core/status/selection-state";
import { Status, type StatusItem, StatusItemType } from "../../core/status/status-item";
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
	 * API: ツリーアイテムを取得する
	 * elementはgetChildrenから渡されるStatusItemのため、インスタンスが入れ替わっていると古い状態になっている可能性がある
	 * 各StatusItem更新ではAssignを使用しているため、最新の状態を反映する
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
		// 設定の検証（必須設定がない場合は空配列を返す）
		const validationError = this.configuration.validate();
		if (validationError) {
			// 設定が未構成の場合は空を返し、ウェルカムビューを表示させる
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
		return this.statusItemTree.getRootDirectoryItems(dirsAbs);
	}

	/**
	 * 指定ディレクトリのファイル・サブディレクトリ一覧のStatusItemを作成する
	 */
	private getStatusItemsRecursive(directoryPath?: string): StatusItem[] {
		if (!directoryPath) {
			return [];
		}

		// StatusItemTreeから子要素を取得
		return this.statusItemTree.getDirectoryChildren(directoryPath);
	}

	/**
	 * 指定ファイルの翻訳ユニット一覧のStatusItemを作成する
	 */
	private getUnitItems(filePath?: string): StatusItem[] {
		if (!filePath) {
			return [];
		}

		// StatusItemTreeから翻訳ユニットを取得
		return this.statusItemTree.getUnitsInFile(filePath);
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
			case Status.Empty:
				return new vscode.ThemeIcon("symbol-variable", new vscode.ThemeColor("charts.yellow"));
			case Status.Error:
				return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
			default:
				return new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.gray"));
		}
	}
}
