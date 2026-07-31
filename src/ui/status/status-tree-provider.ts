import * as path from "node:path";
import * as vscode from "vscode";
import {
	type DirectoryStatusItem,
	Status,
	type StatusItem,
	StatusItemType,
	type UnitStatusItem,
} from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import {
	getSelectedPairAbsDirs,
	getSelectedScopeDirs,
} from "../../commands/shared/status-scope";
import { Configuration } from "../../infra/config/configuration";
import { DebugFireRecorder } from "../../infra/debug/debug-fire-recorder";
import { Logger, formatError } from "../../infra/logging/logger";

/**
 * StatusTree ルート直下の「Needs Attention」仮想ノードの directoryPath に使う識別子。
 * 実在するディレクトリパスと衝突しないよう非パス文字列を用いる（実ディレクトリ探索の対象外）。
 * review / verify-deletion 待ちのユニットを横断集約し、連続裁定を可能にする（UX-R1 §8）。
 */
const NEEDS_ATTENTION_ID = "mdait:needs-attention";

/**
 * need フラグの人間向けラベル（要対応キューの副題・ツールチップ用）
 */
function getNeedLabel(needFlag: string | undefined): string {
	if (needFlag === "verify-deletion") {
		return vscode.l10n.t("Deletion check");
	}
	return vscode.l10n.t("Review");
}

/**
 * ステータスツリービューのデータプロバイダ
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<
		StatusItem | undefined | null
	> = new vscode.EventEmitter<StatusItem | undefined | null>();
	readonly onDidChangeTreeData: vscode.Event<StatusItem | undefined | null> =
		this._onDidChangeTreeData.event;

	private readonly statusManager: StatusManager;
	private readonly configuration: Configuration;
	// StatusItemTreeへの直接アクセス用
	private get statusItemTree() {
		return this.statusManager.getStatusItemTree();
	}

	// ステータス初期化の進行中Promise（全呼び出しが同じ完了を待つ）
	private initPromise: Promise<void> | undefined;

	/**
	 * 直近にルートを構築したときの Needs Attention ノード実体。
	 * getParent が毎回新しいインスタンスを返すと reveal が不安定になるため保持する。
	 */
	private needsAttentionItem: DirectoryStatusItem | undefined;

	/**
	 * Needs Attention ノードを一度でも展開状態で返したか。
	 * 全体再描画のたびに展開し直してユーザーの操作を打ち消さないためのフラグ。
	 * ノードが0件で消えたらリセットし、次に現れたときは再び展開して見せる。
	 */
	private needsAttentionExpandedOnce = false;

	constructor() {
		this.statusManager = StatusManager.getInstance();
		this.configuration = Configuration.getInstance();

		// ツリーに変更があれば全体を描き直す。
		// どのノードを描き直すかは判定しない（ADR-260724-01）。可視ノードの再取得は
		// メモリ参照のみで安価であり、treeItem.id が安定しているため展開状態も維持される。
		this.statusManager.onStatusTreeChanged(() => {
			this.refresh();
		});
	}

	/**
	 * 外部から手動更新したい場合に使用
	 */
	public refresh(): void {
		DebugFireRecorder.getInstance().record("provider", undefined);
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * StatusItemのcollapsibleStateを動的に判定する
	 * VSCodeのTreeViewがUI状態を管理できるよう、getTreeItem呼び出し時に毎回子要素の有無で判定する
	 */
	private determineCollapsibleState(
		element: StatusItem,
	): vscode.TreeItemCollapsibleState {
		switch (element.type) {
			case StatusItemType.Directory:
				// Needs Attention 仮想ノードは、現れた最初の1回だけ展開状態で返す。
				// 全体再描画のたびに Expanded を返すと、ユーザーが畳んでも保存のたびに
				// 勝手に開き直してしまう。2回目以降は Collapsed を返し、展開状態の管理は
				// VS Code（treeItem.id 単位）に委ねる。
				if (element.directoryPath === NEEDS_ATTENTION_ID) {
					if (this.needsAttentionExpandedOnce) {
						return vscode.TreeItemCollapsibleState.Collapsed;
					}
					this.needsAttentionExpandedOnce = true;
					return vscode.TreeItemCollapsibleState.Expanded;
				}
				// ディレクトリは子要素（ファイル・サブディレクトリ）があればCollapsed
				return this.statusItemTree.getDirectoryChildren(element.directoryPath)
					.length > 0
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
	public async revealActiveFile(
		filePath: string,
		treeView: vscode.TreeView<StatusItem>,
	): Promise<void> {
		// 設定が完了していない、またはステータスが初期化されていない場合は何もしない
		if (!this.configuration.isConfigured() || !this.statusManager.isInitialized()) {
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
			Logger.getInstance().debug(
				"status-tree",
				"Failed to reveal file in status tree",
				formatError(error),
			);
		}
	}

	/**
	 * API: ツリーアイテムを取得する
	 * elementはgetChildrenから渡されるStatusItemのため、インスタンスが入れ替わっていると古い状態になっている可能性がある
	 * 各StatusItem更新ではAssignを使用しているため、最新の状態を反映する
	 */
	public getTreeItem(element: StatusItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(
			element.label,
			this.determineCollapsibleState(element),
		);

		// ステータスに応じたアイコンを設定
		treeItem.iconPath = this.getStatusIcon(
			element.status,
			element.isTranslating,
			element,
		);

		// ツールチップを設定
		treeItem.tooltip = this.getTooltip(element);

		// スクリーンリーダー向けの読み上げラベルを設定。
		// 未設定だと tooltip（状態説明だけの文）が aria-label になり、どの項目かが
		// 読み上げから分からなくなるため、「名前 — 状態」の形で明示する。
		// 表示ラベル・副題（description）は変えない。
		treeItem.accessibilityInformation = {
			label: this.getAccessibleLabel(element, treeItem.tooltip),
		};

		// 副題（ラベル右の薄字）を設定
		if (element.description) {
			treeItem.description = element.description;
		}

		// contextValueを設定（StatusItemから）
		treeItem.contextValue = element.contextValue;

		// idを設定
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (element.type === StatusItemType.Directory && element.directoryPath) {
			if (element.directoryPath === NEEDS_ATTENTION_ID) {
				treeItem.id = NEEDS_ATTENTION_ID;
			} else if (workspaceFolder) {
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
		} else if (
			element.type === StatusItemType.Unit &&
			element.filePath &&
			element.unitHash
		) {
			const baseId = workspaceFolder
				? `${path.relative(workspaceFolder, element.filePath)}#${element.unitHash}`
				: `${element.filePath}#${element.unitHash}`;
			// Needs Attention 仮想ノード配下のクローンは、実ファイル配下の本体と同じ id にならないよう
			// サフィックスを付与する（VS Code TreeView は id の一意性を前提とするため）。
			treeItem.id = element.isVirtualCopy ? `${baseId}::needs-attention` : baseId;
		} else if (
			element.type === StatusItemType.Frontmatter &&
			element.filePath
		) {
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
		// Needs Attention仮想ノード配下のクローンの場合、親は仮想ノード自身。
		// reveal を安定させるため、直近にルートを構築したときの実体を返す。
		if (element.type === StatusItemType.Unit && element.isVirtualCopy) {
			return this.needsAttentionItem ?? this.buildNeedsAttentionItem();
		}

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

		// 初期化は1回だけ行い、その間に来た他ノードの getChildren も同じ完了を待つ。
		// 待たずに空配列を返すと、復元された展開状態が空のまま焼き付く。
		await this.ensureStatusInitialized();
		if (!element) {
			// ルート要素の場合はディレクトリ一覧を返す
			return Promise.resolve(this.getRootDirectoryItems());
		}
		if (element.type === StatusItemType.Directory) {
			// Needs Attention仮想ノードの場合は横断集約したユニットクローンを返す
			if (element.directoryPath === NEEDS_ATTENTION_ID) {
				return Promise.resolve(this.getNeedsAttentionChildren());
			}
			// ディレクトリの場合はファイル一覧を返す
			return Promise.resolve(
				this.getStatusItemsRecursive(element.directoryPath),
			);
		}
		if (element.type === StatusItemType.File) {
			// ファイルの場合はfrontmatter + 翻訳ユニット一覧を返す
			return Promise.resolve(this.getFileChildren(element));
		}
		// ユニットタイプ・Frontmatterタイプの場合は子要素なし
		return Promise.resolve([]);
	}

	/**
	 * ステータスツリーの初期化を1回だけ実行する。
	 * 並行呼び出しは同じPromiseを共有し、全員が初期化完了を待ってから結果を返す。
	 */
	private ensureStatusInitialized(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = (async () => {
				try {
					const workspaceFolder =
						vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (workspaceFolder && !this.statusManager.isInitialized()) {
						// 初期化されていない場合は全体再構築
						await this.statusManager.buildStatusItemTree();
					}
				} catch (e) {
					// 失敗を記憶しない。記憶すると、一時的な失敗でツリーが空のまま固定され、
					// VS Code を再読込するまで復帰できなくなる
					this.initPromise = undefined;
					Logger.getInstance().warn(
						"status-tree",
						"failed to initialize status",
						formatError(e),
					);
				}
			})();
		}
		return this.initPromise;
	}

	/**
	 * ディレクトリ一覧のStatusItemを作成する
	 */
	private getRootDirectoryItems(): StatusItem[] {
		// StatusItemTreeからルートディレクトリアイテムを取得
		const items = this.statusItemTree.getRootDirectoryItems(
			getSelectedScopeDirs(this.configuration),
		);
		// Status.Emptyのアイテムを除外
		const visibleItems = items.filter((item) => item.status !== Status.Empty);

		// 未同期ファイル数の副題をターゲットルートに添える
		this.annotateNotYetSyncedFiles(visibleItems);

		// Needs Attention仮想ノードを先頭に追加する（0件時は追加しない＝デッドエンドを作らない）
		const needsAttentionItem = this.buildNeedsAttentionItem();
		return needsAttentionItem
			? [needsAttentionItem, ...visibleItems]
			: visibleItems;
	}

	/**
	 * 各 transPair のターゲットルートに「未同期ファイル数」の副題・ツールチップを添える。
	 *
	 * マーカーの無いファイルは翻訳率の分母（totalUnits）に入らないため、初回 sync の
	 * 前後で「en (5/6)」→「en (5/86)」のように分母が急変して見える。分母の計算自体は
	 * 変えず（isCountedInProgress の意味を保つ）、分母に入っていないファイルの存在を
	 * ここで明示する。集計はスキャン済みツリーのメモリ参照のみで、追加のファイルI/Oはない。
	 */
	private annotateNotYetSyncedFiles(rootItems: StatusItem[]): void {
		for (const pair of getSelectedPairAbsDirs(this.configuration)) {
			const item = rootItems.find(
				(i): i is DirectoryStatusItem =>
					i.type === StatusItemType.Directory &&
					i.directoryPath === pair.targetDirAbs,
			);
			if (!item) {
				continue;
			}
			const count = this.statusItemTree.countFilesNotYetSynced(
				pair.sourceDirAbs,
				pair.targetDirAbs,
			);
			if (count > 0) {
				item.description = vscode.l10n.t("{0} file(s) not yet synced", count);
				item.tooltip = vscode.l10n.t(
					"{0} file(s) under this pair are not yet synced and not counted in the progress. Run Sync to include them.",
					count,
				);
			} else {
				item.description = undefined;
				item.tooltip = undefined;
			}
		}
	}

	/**
	 * review / verify-deletion 待ちのユニットをクローン（isVirtualCopy: true）として返す。
	 * 元のUnitStatusItemは実ファイル配下のツリーからも参照されているため、id衝突を避けるためクローンする。
	 * 集約ロジック自体は StatusItemTree.getNeedsAttentionUnits（VS Code非依存・単体テスト対象）に委譲する。
	 *
	 * 見出しタイトルだけでは同名の見出しが区別できないため、副題にファイル名と種類を出す。
	 */
	private getNeedsAttentionChildren(): UnitStatusItem[] {
		return this.collectNeedsAttentionUnits().map((unit) => ({
			...unit,
			isVirtualCopy: true,
			description: `${path.basename(unit.filePath)} · ${getNeedLabel(unit.needFlag)}`,
			tooltip: this.formatNeedsAttentionTooltip(unit),
		}));
	}

	/**
	 * 要対応ユニットを選択中の transPair に限定して取得する（ツリー本体と同じ範囲に揃える）
	 */
	private collectNeedsAttentionUnits(): UnitStatusItem[] {
		return this.statusItemTree.getNeedsAttentionUnits(
			getSelectedScopeDirs(this.configuration),
		);
	}

	/**
	 * 要対応項目のツールチップ（ワークスペース相対パス＋種類）を組み立てる
	 */
	private formatNeedsAttentionTooltip(unit: UnitStatusItem): string {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const displayPath = workspaceFolder
			? path.relative(workspaceFolder, unit.filePath)
			: unit.filePath;
		return `${displayPath}\n${getNeedLabel(unit.needFlag)}`;
	}

	/**
	 * Needs Attention仮想ノードを構築する。対象が0件の場合はundefined
	 * （UX-P7: デッドエンドを置かない。空のノードをツリーに出さない）。
	 *
	 * 件数ラベルと子リストは同じ集約結果から作られ、ツリー更新のたびに作り直される。
	 * 以前は件数だけがルート構築時のスナップショットで固まり、子リストと食い違っていた
	 * （ADR-260724-01）。
	 */
	private buildNeedsAttentionItem(): DirectoryStatusItem | undefined {
		const count = this.collectNeedsAttentionUnits().length;
		if (count === 0) {
			this.needsAttentionItem = undefined;
			// 次に要対応が現れたときは、また展開した状態で見せる
			this.needsAttentionExpandedOnce = false;
			return undefined;
		}
		this.needsAttentionItem = {
			type: StatusItemType.Directory,
			label: vscode.l10n.t("Needs Attention ({0})", count),
			status: Status.NeedsTranslation,
			directoryPath: NEEDS_ATTENTION_ID,
			contextValue: "mdaitNeedsAttentionRoot",
		};
		return this.needsAttentionItem;
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
	private getFileChildren(
		fileItem: import("../../core/status/status-item").FileStatusItem,
	): StatusItem[] {
		// 非MDファイルはユニット分割されないため子要素なし
		if (!fileItem.filePath.toLowerCase().endsWith(".md")) {
			return [];
		}

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
	 * スクリーンリーダー向けの読み上げラベルを組み立てる。
	 * 「名前 — 副題 — 状態」の順に、あるものだけをつなぐ（tooltip の改行は読点相当に置換）。
	 * 各要素は l10n 済みの文字列なので、組み立て結果もそのままローカライズされる。
	 */
	private getAccessibleLabel(element: StatusItem, tooltip: string): string {
		const parts = [element.label];
		if (element.description) {
			parts.push(element.description);
		}
		const state = tooltip.replace(/\n/g, ", ");
		if (state && state !== element.label) {
			parts.push(state);
		}
		return parts.join(" — ");
	}

	/**
	 * ツールチップを取得する
	 */
	private getTooltip(element: StatusItem): string {
		if (element.tooltip) {
			return element.tooltip;
		}

		if (
			element.type === StatusItemType.Directory &&
			element.directoryPath === NEEDS_ATTENTION_ID
		) {
			return vscode.l10n.t(
				"Units waiting for a review or deletion decision. Click a unit to jump and resolve it.",
			);
		}

		// ユニットのneedFlagを優先して表示
		if (element.type === StatusItemType.Unit && element.needFlag) {
			if (element.needFlag === "review") {
				return vscode.l10n.t("Review required");
			}
			if (element.needFlag.startsWith("revise@")) {
				return vscode.l10n.t("Source changed — revision needed");
			}
			if (element.needFlag === "verify-deletion") {
				return vscode.l10n.t("Source deleted — verify whether to delete this unit");
			}
			if (element.needFlag === "isolate") {
				return vscode.l10n.t("Isolated — kept as-is, excluded from translation");
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
	private getStatusIcon(
		status: Status,
		isProgress?: boolean,
		element?: StatusItem,
	): vscode.ThemeIcon {
		if (isProgress) {
			return new vscode.ThemeIcon("sync~spin");
		}

		// Needs Attention仮想ノードは専用アイコン
		if (
			element?.type === StatusItemType.Directory &&
			element.directoryPath === NEEDS_ATTENTION_ID
		) {
			return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
		}

		// Frontmatter階層の場合はbookアイコンを使用
		if (element?.type === StatusItemType.Frontmatter) {
			switch (status) {
				case Status.Translated:
					return new vscode.ThemeIcon(
						"book",
						new vscode.ThemeColor("charts.green"),
					);
				case Status.NeedsTranslation:
					return new vscode.ThemeIcon("book");
				case Status.Source:
					return new vscode.ThemeIcon(
						"book",
						new vscode.ThemeColor("charts.blue"),
					);
				default:
					return new vscode.ThemeIcon(
						"book",
						new vscode.ThemeColor("charts.gray"),
					);
			}
		}

		// ユニット階層の場合はcircle-smallアイコンを使用
		if (element?.type === StatusItemType.Unit) {
			// needFlagを優先してアイコンを決定
			if (element.needFlag) {
				if (element.needFlag === "review") {
					return new vscode.ThemeIcon(
						"circle-small-filled",
						new vscode.ThemeColor("charts.yellow"),
					);
				}
				if (element.needFlag === "verify-deletion") {
					return new vscode.ThemeIcon(
						"trash",
						new vscode.ThemeColor("charts.orange"),
					);
				}
				if (element.needFlag === "isolate") {
					return new vscode.ThemeIcon(
						"circle-slash",
						new vscode.ThemeColor("charts.gray"),
					);
				}
			}

			// ステータスに応じてアイコンを決定
			switch (status) {
				case Status.Translated:
					return new vscode.ThemeIcon(
						"circle-small-filled",
						new vscode.ThemeColor("charts.green"),
					);
				case Status.NeedsTranslation:
					return new vscode.ThemeIcon("circle-small");
				case Status.Source:
					return new vscode.ThemeIcon(
						"circle-small-filled",
						new vscode.ThemeColor("charts.blue"),
					);
				case Status.Empty:
					return new vscode.ThemeIcon(
						"circle-small-filled",
						new vscode.ThemeColor("charts.yellow"),
					);
				case Status.Error:
					return new vscode.ThemeIcon(
						"circle-small-filled",
						new vscode.ThemeColor("charts.red"),
					);
				default:
					return new vscode.ThemeIcon(
						"circle-small",
						new vscode.ThemeColor("charts.gray"),
					);
			}
		}

		// ファイル・ディレクトリ階層は従来のアイコンを使用
		switch (status) {
			case Status.Translated:
				return new vscode.ThemeIcon(
					"pass",
					new vscode.ThemeColor("charts.green"),
				);
			case Status.NeedsTranslation:
				return new vscode.ThemeIcon("circle");
			case Status.Source:
				return new vscode.ThemeIcon(
					"symbol-constant",
					new vscode.ThemeColor("charts.blue"),
				);
			case Status.Empty:
				return new vscode.ThemeIcon(
					"symbol-variable",
					new vscode.ThemeColor("charts.yellow"),
				);
			case Status.Error:
				return new vscode.ThemeIcon(
					"error",
					new vscode.ThemeColor("charts.red"),
				);
			default:
				return new vscode.ThemeIcon(
					"question",
					new vscode.ThemeColor("charts.gray"),
				);
		}
	}
}
