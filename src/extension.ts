import * as vscode from "vscode";
import { syncCommand } from "./commands/sync/sync-command";
import { detectTermCommand } from "./commands/term/command-detect";
import { StatusTreeTermHandler } from "./commands/term/status-tree-term-handler";
import { StatusTreeTranslationHandler } from "./commands/trans/status-tree-translation-handler";
import { transCommand } from "./commands/trans/trans-command";
import { Configuration } from "./config/configuration";
import { SelectionState } from "./core/status/selection-state";
import type { StatusItem } from "./core/status/status-item";
import { StatusManager } from "./core/status/status-manager";
import { codeLensJumpToSourceCommand, codeLensTranslateCommand } from "./ui/codelens/codelens-command";
import { MdaitCodeLensProvider } from "./ui/codelens/codelens-provider";
import { StatusTreeProvider } from "./ui/status/status-tree-provider";

export function activate(context: vscode.ExtensionContext) {
	// StatusManagerの初期化
	const statusManager = StatusManager.getInstance();
	const config = Configuration.getInstance();

	// ステータスツリービューを作成
	const statusTreeProvider = new StatusTreeProvider();
	const treeView = vscode.window.createTreeView("mdait.status", {
		treeDataProvider: statusTreeProvider,
		showCollapseAll: false,
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

	// 設定変更で transPairs が変わった場合の補正
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration("mdait")) {
			selectionState.reconcileWith(config.transPairs);
		}
	});

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

	// 初回データ読み込み
	context.subscriptions.push(
		syncDisposable,
		selectTargetsDisposable,
		transDisposable,
		termDetectDisposable,
		termDirectoryDisposable,
		termFileDisposable,
		codeLensTranslateDisposable,
		codeLensJumpToSourceDisposable,
		codeLensDisposable,
		translateDirectoryDisposable,
		translateFileDisposable,
		translateUnitDisposable,
		treeView,
		syncStatusDisposable,
		jumpToUnitDisposable,
	);

	// contextのsubscriptionsに追加することで、自動的にdisposeが呼ばれる
	context.subscriptions.push({
		dispose: () => statusManager.dispose(),
	});
}
