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
	}

	/**
	 * ツリーデータをリフレッシュする
	 * @param item 更新したいStatusItem（省略時は全体）
	 */
	public async refreshTree(): Promise<void> {
		try {
			// 設定が有効かチェック
			const validationError = this.configuration.validate();
			if (validationError) {
				vscode.window.showWarningMessage(validationError);
				// エラー時はツリーをクリア
				this.statusItemTree.clear();
			} else {
				// StatusManagerから最新のStatusItemを取得
				if (!this.statusManager.isInitialized()) {
					// 初期化されていない場合は全体再構築
					await this.statusManager.buildAllStatusItem();
				}
			}

			// ツリービューを全体更新
			this._onDidChangeTreeData.fire(undefined);
		} catch (error) {
			console.error("Error refreshing status tree:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error refreshing status tree: {0}", (error as Error).message));
		}
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
		if (!this.isStatusInitialized && !this.isStatusLoading) {
			this.isStatusLoading = true;
			try {
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceFolder) {
					// StatusManagerから最新のStatusItemを取得・ツリーに反映
					if (!this.statusManager.isInitialized()) {
						// 初期化されていない場合は全体再構築
						await this.statusManager.buildAllStatusItem();
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
		// transPairs.targetDirとsourceDirの絶対パス一覧を作成
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const allDirsAbs = this.configuration.transPairs.flatMap((pair) => [
			workspaceFolder ? path.resolve(workspaceFolder, pair.sourceDir) : pair.sourceDir,
			workspaceFolder ? path.resolve(workspaceFolder, pair.targetDir) : pair.targetDir,
		]);

		// StatusItemTreeからルートディレクトリアイテムを取得
		return this.statusItemTree.getRootDirectoryItems(allDirsAbs);
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
		return this.statusItemTree.getFileUnits(filePath);
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
	 * 特定ファイルのStatusItemを部分更新
	 * パフォーマンス改善とUI競合回避のため
	 */
	public updateFileStatus(filePath: string, updatedFileItem: StatusItem): void {
		// StatusItemTreeを直接更新
		this.statusItemTree.addOrUpdateFile(updatedFileItem);

		// 該当ファイルアイテムのみツリー更新
		this._onDidChangeTreeData.fire(updatedFileItem);
	}

	/**
	 * 特定ユニットのStatusItemを部分更新
	 * パフォーマンス改善とUI競合回避のため
	 */
	public updateUnitStatus(unitHash: string, updates: Partial<StatusItem>, filePath: string): void {
		// StatusItemTreeからユニットを検索
		const unit = this.statusItemTree.findUnitByHash(unitHash);
		if (!unit) {
			return;
		}

		// ユニットを部分更新
		Object.assign(unit, updates);

		// 親ファイルを検索
		const parentFile = filePath ? this.statusItemTree.getFileItem(filePath) : null;

		// 親ファイルの状態を再集計・更新
		if (parentFile) {
			this.updateParentStatus(parentFile);
		}

		// 更新されたユニットのツリー表示を更新
		this._onDidChangeTreeData.fire(unit);
	}

	/**
	 * StatusManagerからの更新通知を受けてツリーを更新
	 */
	public statusTreeChanged(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * 親StatusItem（ファイル→ディレクトリ）の状態を再集計・更新
	 */
	private updateParentStatus(fileItem: StatusItem): void {
		if (fileItem.type !== StatusItemType.File || !fileItem.children) {
			return;
		}

		// ファイルのisTranslatingとstatusを子ユニットから集計
		const hasTranslatingUnit = fileItem.children.some((unit) => unit.isTranslating === true);
		const hasErrorUnit = fileItem.children.some((unit) => unit.status === Status.Error);
		const translatedCount = fileItem.children.filter((unit) => unit.status === Status.Translated).length;
		const totalCount = fileItem.children.length;

		// ファイルの状態を更新
		const oldIsTranslating = fileItem.isTranslating;
		const oldStatus = fileItem.status;

		fileItem.isTranslating = hasTranslatingUnit;

		if (hasErrorUnit) {
			fileItem.status = Status.Error;
		} else if (translatedCount === totalCount && totalCount > 0) {
			fileItem.status = Status.Translated;
		} else if (translatedCount > 0) {
			fileItem.status = Status.NeedsTranslation;
		} else {
			fileItem.status = Status.NeedsTranslation;
		}

		// ファイルの状態が変わった場合、親ディレクトリも更新
		if (oldIsTranslating !== fileItem.isTranslating || oldStatus !== fileItem.status) {
			this.updateDirectoryStatus(fileItem.filePath);
			// ファイルの表示を更新
			this._onDidChangeTreeData.fire(fileItem);
		}
	}

	/**
	 * ディレクトリの状態を再集計・更新
	 */
	private updateDirectoryStatus(filePath?: string): void {
		if (!filePath) return;

		const directoryPath = path.dirname(filePath);

		// StatusItemTreeから該当ディレクトリ配下のファイルを取得
		const filesInDir = this.statusItemTree.getDirectoryFiles(directoryPath);

		if (filesInDir.length === 0) return;

		// ディレクトリの状態を集計
		const hasTranslatingFile = filesInDir.some((file) => file.isTranslating === true);
		const directoryStatus = this.determineDirectoryStatus(filesInDir);

		// getRootDirectoryItemsやgetStatusItemsRecursiveで生成されるディレクトリアイテムを更新
		// 直接更新せず、該当ディレクトリの再描画を促す
		this._onDidChangeTreeData.fire(undefined);
	}
}
