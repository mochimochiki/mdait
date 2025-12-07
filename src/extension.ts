import * as vscode from "vscode";
import { createSettingsCommand } from "./commands/setup/create-settings-command";
import { syncCommand } from "./commands/sync/sync-command";
import { addToGlossaryCommand } from "./commands/term/command-add";
import { detectTermCommand } from "./commands/term/command-detect";
import { expandTermCommand } from "./commands/term/command-expand";
import { openTermCommand } from "./commands/term/command-open";
import { StatusTreeTermHandler } from "./commands/term/status-tree-term-handler";
import { StatusTreeTranslationHandler } from "./commands/trans/status-tree-translation-handler";
import { transCommand } from "./commands/trans/trans-command";
import { Configuration } from "./config/configuration";
import { SelectionState } from "./core/status/selection-state";
import type { StatusItem } from "./core/status/status-item";
import { StatusManager } from "./core/status/status-manager";
import { codeLensJumpToSourceCommand, codeLensTranslateCommand } from "./ui/codelens/codelens-command";
import { MdaitCodeLensProvider } from "./ui/codelens/codelens-provider";
import { SummaryDecorator } from "./ui/hover/summary-decorator";
import { SummaryManager } from "./ui/hover/summary-manager";
import { TranslationSummaryHoverProvider } from "./ui/hover/translation-summary-hover-provider";
import { StatusTreeProvider } from "./ui/status/status-tree-provider";
import { FileExplorer } from "./utils/file-explorer";

export async function activate(context: vscode.ExtensionContext) {
	// Configuration の初期化
	try {
		await Configuration.getInstance().initialize();
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("Failed to load mdait.yaml configuration: {0}", (error as Error).message),
		);
		return;
	}

	// StatusManagerの初期化
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	// ステータスツリービューを作成
	const statusTreeProvider = new StatusTreeProvider();
	const treeView = vscode.window.createTreeView("mdait.status", {
		treeDataProvider: statusTreeProvider,
		showCollapseAll: true,
	});

	// SelectionState 初期化（前回復元→先頭フォールバック）
	const selectionState = SelectionState.getInstance();
	selectionState.initialize(context).then(() => {
		// 初期化後に transPairs と整合
		selectionState.reconcileWith(config.transPairs);
	});

	// 選択変更時はツリー更新
	selectionState.onChanged(() => {
		statusTreeProvider.refresh();
	});

	// 設定の検証とコンテキスト設定
	const updateConfigurationContext = () => {
		const validationError = config.validate();
		const isConfigured = validationError === null;
		vscode.commands.executeCommand("setContext", "mdaitConfigured", isConfigured);
		// 設定が変更された場合はツリーを更新（未設定→設定済み、または設定済み→未設定の切り替え時）
		statusTreeProvider.refresh();
	};

	// 初期チェック
	updateConfigurationContext();

	// 設定変更時の処理を統合
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration("mdait")) {
			updateConfigurationContext();
			selectionState.reconcileWith(config.transPairs);
		}
	});

	// setup.createSettings command
	const createSettingsDisposable = vscode.commands.registerCommand("mdait.setup.createSettings", createSettingsCommand);

	// sync command
	const syncDisposable = vscode.commands.registerCommand("mdait.sync", syncCommand);

	// trans command
	const transDisposable = vscode.commands.registerCommand("mdait.trans", transCommand);

	// Trans handler
	const translateItemCommand = new StatusTreeTranslationHandler();
	translateItemCommand.setStatusTreeProvider(statusTreeProvider);

	const translateDirectoryDisposable = vscode.commands.registerCommand("mdait.translate.directory", (item) =>
		translateItemCommand.translateDirectory(item),
	);
	const translateFileDisposable = vscode.commands.registerCommand("mdait.translate.file", (item) =>
		translateItemCommand.translateFile(item),
	);
	const translateUnitDisposable = vscode.commands.registerCommand("mdait.translate.unit", (item) =>
		translateItemCommand.translateUnit(item),
	);

	// term.detect command
	const termDetectDisposable = vscode.commands.registerCommand("mdait.term.detect", detectTermCommand);

	// term.expand command
	const termExpandDisposable = vscode.commands.registerCommand("mdait.term.expand", (item) =>
		expandTermCommand(item as StatusItem),
	);

	// term.open command
	const termOpenDisposable = vscode.commands.registerCommand("mdait.term.open", openTermCommand);

	// term.addToGlossary command
	const addToGlossaryDisposable = vscode.commands.registerCommand("mdait.addToGlossary", addToGlossaryCommand);

	// Term handler
	const termHandler = new StatusTreeTermHandler();
	termHandler.setStatusTreeProvider(statusTreeProvider);

	const termDirectoryDisposable = vscode.commands.registerCommand("mdait.term.detect.directory", (item) =>
		termHandler.termDetectDirectory(item as StatusItem),
	);
	const termFileDisposable = vscode.commands.registerCommand("mdait.term.detect.file", (item) =>
		termHandler.termDetectFile(item as StatusItem),
	);

	// CodeLens翻訳コマンド
	const codeLensTranslateDisposable = vscode.commands.registerCommand(
		"mdait.codelens.translate",
		codeLensTranslateCommand,
	);

	// CodeLensソースジャンプコマンド
	const codeLensJumpToSourceDisposable = vscode.commands.registerCommand(
		"mdait.codelens.jumpToSource",
		codeLensJumpToSourceCommand,
	);

	// CodeLensProvider登録
	const codeLensProvider = new MdaitCodeLensProvider();
	const codeLensDisposable = vscode.languages.registerCodeLensProvider(
		{ scheme: "file", language: "markdown" },
		codeLensProvider,
	);

	// HoverProvider登録
	const summaryManager = SummaryManager.getInstance();
	const hoverProvider = new TranslationSummaryHoverProvider(summaryManager);
	const hoverDisposable = vscode.languages.registerHoverProvider(
		{ scheme: "file", language: "markdown" },
		hoverProvider,
	);

	// SummaryDecorator登録
	const summaryDecorator = new SummaryDecorator(summaryManager);

	// アクティブエディタ変更時にDecorationを更新
	vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor?.document.languageId === "markdown") {
				summaryDecorator.updateDecorations(editor);
			}
		},
		null,
		context.subscriptions,
	);

	// ドキュメント変更時にDecorationを更新（保存時など）
	vscode.workspace.onDidChangeTextDocument(
		(event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && event.document === editor.document && editor.document.languageId === "markdown") {
				summaryDecorator.updateDecorations(editor);
			}
		},
		null,
		context.subscriptions,
	);

	// status.refresh command
	const syncStatusDisposable = vscode.commands.registerCommand("mdait.status.sync", async () => {
		try {
			await vscode.commands.executeCommand("setContext", "mdaitSyncProcessing", true);
			await syncCommand();
			// StatusManagerから初期化されたStatusTreeProviderのrefreshを呼ぶ
			await statusManager.buildStatusItemTree();
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t("Failed to sync and refresh: {0}", (error as Error).message));
		} finally {
			await vscode.commands.executeCommand("setContext", "mdaitSyncProcessing", false);
		}
	});

	// status.openTerm command
	const openTermStatusDisposable = vscode.commands.registerCommand("mdait.status.openTerm", openTermCommand);

	// jumpToUnit command
	const jumpToUnitDisposable = vscode.commands.registerCommand(
		"mdait.jumpToUnit",
		async (filePath: string, line: number) => {
			try {
				const document = await vscode.workspace.openTextDocument(filePath);
				const editor = await vscode.window.showTextDocument(document);

				// 指定行にジャンプ（0ベースから1ベースに変換）
				const position = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Failed to jump to unit: {0}", (error as Error).message));
			}
		},
	);

	// 対象言語選択コマンド（QuickPick: 複数選択、空は確定不可）
	const selectTargetsDisposable = vscode.commands.registerCommand("mdait.status.selectTargets", async () => {
		const pick = vscode.window.createQuickPick<{ label: string; description?: string; key: string }>();
		pick.canSelectMany = true;
		const items = SelectionState.getInstance()
			.getSelectableTargets()
			.map((t) => ({ label: t.label, description: t.description, key: t.key }));
		pick.items = items;
		// 既存選択を反映
		const selectedKeys = Array.from(SelectionState.getInstance().getActiveKeys());
		pick.selectedItems = items.filter((i) => selectedKeys.includes(i.key));

		// 空禁止: accept を抑止（代替メッセージはタイトルに表示）
		pick.onDidAccept(() => {
			const keys = pick.selectedItems.map((i) => i.key);
			if (keys.length === 0) {
				pick.title = vscode.l10n.t("Select at least one target.");
				return; // stay open
			}
			SelectionState.getInstance().updateSelection(keys);
			pick.hide();
		});
		pick.onDidHide(() => pick.dispose());
		pick.show();
	});

	// ドキュメント保存時のステータス更新
	const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
		try {
			if (document.uri.scheme !== "file") {
				return;
			}
			const filePath = document.uri.fsPath;
			if (!filePath.toLowerCase().endsWith(".md")) {
				return;
			}
			let shouldRefresh = false;
			try {
				const fileExplorer = new FileExplorer();
				shouldRefresh = fileExplorer.isSourceFile(filePath, config) || fileExplorer.isTargetFile(filePath, config);
			} catch (error) {
				console.warn("mdait: failed to initialize FileExplorer on save", error);
			}
			if (!shouldRefresh) {
				const tree = statusManager.getStatusItemTree();
				shouldRefresh = !!tree.getFile(filePath);
			}
			if (!shouldRefresh) {
				return;
			}
			if (!statusManager.isInitialized()) {
				await statusManager.buildStatusItemTree();
				return;
			}
			await statusManager.refreshFileStatus(filePath);
		} catch (error) {
			console.warn("mdait: failed to refresh status on save", error);
		}
	});

	// 初回データ読み込み
	context.subscriptions.push(
		createSettingsDisposable,
		syncDisposable,
		selectTargetsDisposable,
		transDisposable,
		termDetectDisposable,
		termExpandDisposable,
		termOpenDisposable,
		addToGlossaryDisposable,
		termDirectoryDisposable,
		termFileDisposable,
		codeLensTranslateDisposable,
		codeLensJumpToSourceDisposable,
		codeLensDisposable,
		hoverDisposable,
		translateDirectoryDisposable,
		translateFileDisposable,
		translateUnitDisposable,
		saveDisposable,
		treeView,
		syncStatusDisposable,
		openTermStatusDisposable,
		jumpToUnitDisposable,
	);

	// contextのsubscriptionsに追加することで、自動的にdisposeが呼ばれる
	context.subscriptions.push({
		dispose: () => statusManager.dispose(),
	});

	context.subscriptions.push({
		dispose: () => summaryDecorator.dispose(),
	});
}
