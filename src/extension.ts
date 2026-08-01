import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { adoptCommand } from "./commands/adopt/adopt-command";
import { aiReviewDirectoryCommand, aiReviewFileCommand } from "./commands/ai-review/review-command";
import { AiReviewResultCodeLensProvider } from "./commands/ai-review/review-result-provider";
import { diagnoseSetupCommand } from "./commands/doctor/doctor-command";
import { getFileHandler } from "./commands/file-handler/file-handler-factory";
import { StatusCollector } from "./commands/file-handler/status-collector";
import { embedMarkersCommand, externalizeMarkersCommand } from "./commands/markers/markers-migration";
import { needsAttentionNextCommand } from "./commands/markers/needs-attention-next";
import { StatusTreeNeedHandler } from "./commands/markers/status-tree-need-handler";
import { createConfigCommand, openExistingConfigCommand } from "./commands/setup/setup-command";
import { syncCommand, syncSingleFile } from "./commands/sync/sync-command";
import { addToGlossaryCommand } from "./commands/term/command-add";
import { detectTermCommand } from "./commands/term/command-detect";
import { expandTermCommand } from "./commands/term/command-expand";
import { openTermCommand } from "./commands/term/command-open";
import { StatusTreeTermHandler } from "./commands/term/status-tree-term-handler";
import { tmCommitDirectoryCommand, tmCommitFileCommand } from "./commands/tm/command-commit";
import { openTmCommand } from "./commands/tm/command-open";
import { tmOptimizeCommand } from "./commands/tm/command-optimize";
import { translateSelectionCommand } from "./commands/trans-selection/trans-selection-command";
import { StatusTreeTranslationHandler } from "./commands/trans/status-tree-translation-handler";
import { transCommand, translateFrontmatterCommand } from "./commands/trans/trans-command";
import { validateCommand } from "./commands/validate/validate-command";
import { SelectionState } from "./core/status/selection-state";
import { type StatusItem, isFrontmatterStatusItem } from "./core/status/status-item";
import { StatusManager } from "./core/status/status-manager";
import { UnitStateStore } from "./core/unit-state/unit-state-store";
import { Configuration } from "./infra/config/configuration";
import { Logger, parseLogLevel } from "./infra/logging/logger";
import { AIOnboarding } from "./infra/onboarding/ai-onboarding";
import { FileExplorer } from "./infra/workspace/file-explorer";
import { MdaitAdoptTool } from "./lm-tools/adopt-tool";
import { MdaitAiReviewTool } from "./lm-tools/ai-review-tool";
import { MdaitGetStatusTool } from "./lm-tools/get-status-tool";
import { MdaitResolveTool } from "./lm-tools/resolve-tool";
import { MdaitSyncTool } from "./lm-tools/sync-tool";
import { MdaitTermTool } from "./lm-tools/term-tool";
import { MdaitTmTool } from "./lm-tools/tm-tool";
import { MdaitTranslateTool } from "./lm-tools/translate-tool";
import { MdaitValidateTool } from "./lm-tools/validate-tool";
import {
	codeLensClearFileNeedCommand,
	codeLensClearFrontmatterNeedCommand,
	codeLensClearNeedCommand,
	codeLensDeleteUnitCommand,
	codeLensJumpToSourceCommand,
	codeLensJumpToSourceFileCommand,
	codeLensJumpToSourceFrontmatterCommand,
	codeLensJumpToTargetCommand,
	codeLensJumpToTargetFileCommand,
	codeLensOtherActionsCommand,
	codeLensTranslateCommand,
	codeLensTranslateFileCommand,
	editNoteForUnitCommand,
} from "./ui/codelens/codelens-command";
import { MdaitCodeLensProvider } from "./ui/codelens/codelens-provider";
import { SummaryDecorator } from "./ui/hover/summary-decorator";
import { SummaryManager } from "./ui/hover/summary-manager";
import { TranslationSummaryHoverProvider } from "./ui/hover/translation-summary-hover-provider";
import {
	SettingsEditorProvider,
	openSettingsAsJsonCommand,
	openSettingsAsUiCommand,
} from "./ui/settings/settings-editor-provider";
import { SettingsPanel } from "./ui/settings/settings-panel";
import { StatusTreeProvider } from "./ui/status/status-tree-provider";

export async function activate(context: vscode.ExtensionContext) {
	// OutputChannel作成とLogger初期化
	const outputChannel = vscode.window.createOutputChannel("mdait");
	const logger = Logger.getInstance();
	logger.initialize(outputChannel);

	// 設定からログレベルを読み込み
	const vsConfig = vscode.workspace.getConfiguration("mdait");
	const logLevelStr = vsConfig.get<string>("logLevel", "INFO");
	logger.setLevel(parseLogLevel(logLevelStr));

	logger.info("extension", "mdait extension activating");

	// Configuration の初期化
	const config = Configuration.getInstance();
	let configInitialized = false;

	try {
		const customConfigPath = context.workspaceState.get<string>("mdait.configPath");
		await config.initialize(customConfigPath);
		configInitialized = true;
		logger.info("config", "Configuration loaded successfully");

		// UnitStateStoreの起動時ロード（非MDファイルの翻訳状態を即座に利用可能にする）
		const mdaitDir = config.getMdaitDir();
		if (fs.existsSync(mdaitDir)) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	} catch (error) {
		// 設定ファイルがない場合はエラーを表示せず、Welcome Viewを表示するため続行
		logger.info("config", "Configuration not loaded", {
			reason: (error as Error).message,
		});
		// 設定ファイルが存在するのに読み込めない場合（JSON構文エラー等）は
		// Welcome View だけでは原因が分からないため、ユーザーに通知する
		const configFilePath = config.getConfigFilePath();
		if (configFilePath && fs.existsSync(configFilePath)) {
			vscode.window.showErrorMessage(vscode.l10n.t("Failed to load mdait.json: {0}", (error as Error).message));
		}
	}

	// AIOnboarding の初期化
	const aiOnboarding = AIOnboarding.getInstance();
	aiOnboarding.initialize(context);

	// mdaitConfiguredコンテキスト変数を初期化
	await updateConfiguredContext(config);

	// StatusManagerの初期化
	const statusManager = StatusManager.getInstance();
	statusManager.setCollector(new StatusCollector());

	// mdaitHasStatusコンテキスト変数を初期化
	await updateHasStatusContext(statusManager);

	// ステータスツリービューを作成
	const statusTreeProvider = new StatusTreeProvider();
	const treeView = vscode.window.createTreeView("mdait.status", {
		treeDataProvider: statusTreeProvider,
		showCollapseAll: true,
	});

	// SelectionState 初期化（前回復元→先頭フォールバック）
	const selectionState = SelectionState.getInstance();
	selectionState
		.initialize(context)
		.then(() => {
			// 初期化後に transPairs と整合
			selectionState.reconcileWith(config.transPairs);
		})
		.catch((error) => {
			logger.warn("extension", "Failed to initialize selection state", {
				error: (error as Error).message,
			});
		});

	// 選択変更時はツリー更新
	selectionState.onChanged(() => {
		statusTreeProvider.refresh();
	});

	// 設定変更で transPairs が変わった場合の補正とコンテキスト変数更新
	config.onConfigurationChanged(() => {
		selectionState.reconcileWith(config.transPairs);
		updateConfiguredContext(config);
		updateHasStatusContext(statusManager);
		statusTreeProvider.refresh();
	});

	// VSCode設定変更時にログレベルを更新
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("mdait.logLevel")) {
				const newLogLevel = vscode.workspace.getConfiguration("mdait").get<string>("logLevel", "INFO");
				logger.setLevel(parseLogLevel(newLogLevel));
				logger.info("config", "Log level changed", { logLevel: newLogLevel });
			}
		}),
	);

	// ステータスツリー変更時にmdaitHasStatusを更新
	statusManager.onStatusTreeChanged(() => {
		updateHasStatusContext(statusManager);
	});

	// setup.createConfig command
	const createConfigDisposable = vscode.commands.registerCommand("mdait.setup.createConfig", () =>
		createConfigCommand(context),
	);

	// setup.openExistingConfig command
	const openExistingConfigDisposable = vscode.commands.registerCommand("mdait.setup.openExistingConfig", () =>
		openExistingConfigCommand(context),
	);

	// settings.open command（mdait.json 設定エディタ）
	const openSettingsDisposable = vscode.commands.registerCommand("mdait.settings.open", () => SettingsPanel.open());

	// mdait.json をエディタで開いたとき、デフォルトで設定UIを表示するプロバイダー
	const settingsEditorProviderDisposable = vscode.window.registerCustomEditorProvider(
		SettingsPanel.viewType,
		new SettingsEditorProvider(context.extensionUri),
		{
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: false,
		},
	);

	// 設定UI ⇔ JSON のエディタ表示切り替えボタン（editor/title）
	const openSettingsAsJsonDisposable = vscode.commands.registerCommand(
		"mdait.settings.openAsJson",
		openSettingsAsJsonCommand,
	);
	const openSettingsAsUiDisposable = vscode.commands.registerCommand(
		"mdait.settings.openAsUi",
		openSettingsAsUiCommand,
	);

	// setup.diagnose command（セットアップ診断）
	const diagnoseSetupDisposable = vscode.commands.registerCommand("mdait.setup.diagnose", diagnoseSetupCommand);

	/**
	 * sync の実処理。**入口が3つあっても中身はこれ1つ**にする。
	 *
	 * 以前はツリーのボタン用とパレット用で別々に書かれており、パレットから実行したときだけ
	 * 全体再構築が行われず、新しく増えた／消えたファイルがツリーに反映されなかった。
	 * 表示（タイトル・アイコン・出す条件）はコマンド宣言と `when` 句だけで分ける。
	 *
	 * @param options debug-ipc / E2E からの adopt 指定などに使う
	 */
	const runSync = async (options?: Parameters<typeof syncCommand>[0]): Promise<void> => {
		try {
			await vscode.commands.executeCommand("setContext", "mdaitSyncProcessing", true);
			await syncCommand(options);
			// ファイル単位の更新は syncCommand 内で行われるが、ファイルの増減は
			// 全体再構築でしかツリーに反映されない
			await statusManager.buildStatusItemTree();
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t("Failed to sync and refresh: {0}", (error as Error).message));
		} finally {
			await vscode.commands.executeCommand("setContext", "mdaitSyncProcessing", false);
		}
	};

	const syncDisposable = vscode.commands.registerCommand("mdait.sync", (options?: Parameters<typeof syncCommand>[0]) =>
		runSync(options),
	);

	// trans command
	const transDisposable = vscode.commands.registerCommand("mdait.trans", transCommand);

	// validate command（読取専用・AI不使用。mdait_validate ツールと同じコアを人間サーフェスへ開く）
	const validateDisposable = vscode.commands.registerCommand("mdait.validate", validateCommand);

	// マーカー外部化 / 埋め込み戻し コマンド
	const externalizeMarkersDisposable = vscode.commands.registerCommand(
		"mdait.markers.externalize",
		externalizeMarkersCommand,
	);
	const embedMarkersDisposable = vscode.commands.registerCommand("mdait.markers.embed", embedMarkersCommand);

	// Trans handler
	const translateItemCommand = new StatusTreeTranslationHandler();
	translateItemCommand.setStatusTreeProvider(statusTreeProvider);

	const translateDirectoryDisposable = vscode.commands.registerCommand("mdait.translate.directory", (item) =>
		translateItemCommand.translateDirectory(item),
	);
	// sync 完了通知の「今すぐ翻訳」から呼ばれる内部コマンド（パレットには出さない）
	const translatePendingDisposable = vscode.commands.registerCommand("mdait.trans.pendingTargets", () =>
		translateItemCommand.translatePendingTargets(),
	);
	const translateFileDisposable = vscode.commands.registerCommand("mdait.translate.file", (item) =>
		translateItemCommand.translateFile(item),
	);
	const translateUnitDisposable = vscode.commands.registerCommand("mdait.translate.unit", (item) =>
		translateItemCommand.translateUnit(item),
	);

	// StatusTree ユニット need 裁定ハンドラ（UX-R1: 判断サーフェスの完成）
	const needHandler = new StatusTreeNeedHandler();
	const unitMarkReviewedDisposable = vscode.commands.registerCommand("mdait.unit.markReviewed", (item?: StatusItem) =>
		needHandler.markReviewed(item),
	);
	const unitKeepDisposable = vscode.commands.registerCommand("mdait.unit.keep", (item?: StatusItem) =>
		needHandler.keepUnit(item),
	);
	const unitDeleteDisposable = vscode.commands.registerCommand("mdait.unit.delete", (item?: StatusItem) =>
		needHandler.deleteUnit(item),
	);
	const unitMarkIsolatedDisposable = vscode.commands.registerCommand("mdait.unit.markIsolated", (item?: StatusItem) =>
		needHandler.markIsolated(item),
	);
	const unitUnisolateDisposable = vscode.commands.registerCommand("mdait.unit.unisolate", (item?: StatusItem) =>
		needHandler.unisolate(item),
	);
	// 要対応キューの連続裁定（UX-R4: 裁定→次へ の往復をなくす）
	const needsAttentionNextDisposable = vscode.commands.registerCommand(
		"mdait.needsAttention.next",
		needsAttentionNextCommand,
	);

	// term.detect command
	const termDetectDisposable = vscode.commands.registerCommand("mdait.term.detect", detectTermCommand);

	// term.expand command
	const termExpandDisposable = vscode.commands.registerCommand("mdait.term.expand", (item) =>
		expandTermCommand(item as StatusItem),
	);

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

	// term.expand.directory/file commands
	const termExpandDirectoryDisposable = vscode.commands.registerCommand("mdait.term.expand.directory", (item) =>
		termHandler.termExpandDirectory(item as StatusItem),
	);
	const termExpandFileDisposable = vscode.commands.registerCommand("mdait.term.expand.file", (item) =>
		termHandler.termExpandFile(item as StatusItem),
	);

	// Translate Selection command
	const translateSelectionDisposable = vscode.commands.registerCommand(
		"mdait.translateSelection",
		translateSelectionCommand,
	);

	// TM Commit commands
	const tmCommitFileDisposable = vscode.commands.registerCommand("mdait.tm.commit.file", (item?: StatusItem) =>
		tmCommitFileCommand(item),
	);
	const tmCommitDirectoryDisposable = vscode.commands.registerCommand(
		"mdait.tm.commit.directory",
		(item?: StatusItem) => tmCommitDirectoryCommand(item),
	);
	const tmOptimizeDisposable = vscode.commands.registerCommand("mdait.tm.optimize", tmOptimizeCommand);

	// AI Review commands
	const aiReviewFileDisposable = vscode.commands.registerCommand("mdait.aiReview.file", (item?: StatusItem) =>
		aiReviewFileCommand(item),
	);
	const aiReviewDirectoryDisposable = vscode.commands.registerCommand("mdait.aiReview.directory", (item?: StatusItem) =>
		aiReviewDirectoryCommand(item),
	);

	// Adopt command（取り込みウィザード。ワークスペース全体）
	const adoptDisposable = vscode.commands.registerCommand("mdait.adopt.run", () => adoptCommand());

	// AIレビューレポート（.mdait/reports/ai-review.md）の flagged 行に
	// 「note を編集」CodeLens を出す。対象ファイルの絞り込みはプロバイダー側で行う
	const aiReviewResultCodeLensDisposable = vscode.languages.registerCodeLensProvider(
		{ scheme: "file", language: "markdown" },
		new AiReviewResultCodeLensProvider(),
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

	// CodeLensターゲットジャンプコマンド
	const codeLensJumpToTargetDisposable = vscode.commands.registerCommand(
		"mdait.codelens.jumpToTarget",
		codeLensJumpToTargetCommand,
	);

	// CodeLens need削除コマンド
	const codeLensClearNeedDisposable = vscode.commands.registerCommand(
		"mdait.codelens.clearNeed",
		codeLensClearNeedCommand,
	);

	// CodeLens verify-deletion 削除コマンド（UX-R1: 判断サーフェスの完成）
	const codeLensDeleteUnitDisposable = vscode.commands.registerCommand(
		"mdait.codelens.deleteUnit",
		codeLensDeleteUnitCommand,
	);

	// Frontmatter翻訳コマンド（StatusTree/CodeLensから呼び出し）
	const translateFrontmatterDisposable = vscode.commands.registerCommand(
		"mdait.translate.frontmatter",
		(arg?: vscode.Uri | StatusItem) => {
			// StatusTreeから呼び出された場合、itemからuriを取得
			if (arg && isFrontmatterStatusItem(arg as StatusItem)) {
				const item = arg as { filePath: string };
				return translateFrontmatterCommand(vscode.Uri.file(item.filePath));
			}
			return translateFrontmatterCommand(arg as vscode.Uri | undefined);
		},
	);

	// CodeLens Frontmatter need削除コマンド
	const codeLensClearFrontmatterNeedDisposable = vscode.commands.registerCommand(
		"mdait.codelens.clearFrontmatterNeed",
		codeLensClearFrontmatterNeedCommand,
	);

	// CodeLens ソースFrontmatterジャンプコマンド
	const codeLensJumpToSourceFrontmatterDisposable = vscode.commands.registerCommand(
		"mdait.codelens.jumpToSourceFrontmatter",
		codeLensJumpToSourceFrontmatterCommand,
	);

	// CodeLensProvider登録
	const codeLensProvider = new MdaitCodeLensProvider();
	const codeLensDisposable = vscode.languages.registerCodeLensProvider(
		// 全ファイル対象。実際の絞り込みは provider 内で languageId/拡張子で行う
		{ scheme: "file" },
		codeLensProvider,
	);
	// ステータスツリー変更時にCodelensを更新（plainファイルはファイル本体が変わらないため明示的にrefreshが必要）
	statusManager.onStatusTreeChanged(() => {
		codeLensProvider.refresh();
	});

	// CodeLens「その他」メニュー（isolate 宣言・note 編集。ADR-260719-01）
	const codeLensOtherActionsDisposable = vscode.commands.registerCommand(
		"mdait.codelens.otherActions",
		async (range: vscode.Range) => {
			await codeLensOtherActionsCommand(range);
			codeLensProvider.refresh();
		},
	);
	// レポート（仮想ドキュメント）の CodeLens から、対象ファイルの該当ユニットへ飛んで note を編集
	const editNoteForUnitDisposable = vscode.commands.registerCommand(
		"mdait.unit.editNoteForUnit",
		async (filePath: string, unitHash: string) => {
			await editNoteForUnitCommand(filePath, unitHash);
			codeLensProvider.refresh();
		},
	);

	// 非Markdownファイル用CodeLensコマンド（プレーンファイル単位）
	const codeLensTranslateFileDisposable = vscode.commands.registerCommand(
		"mdait.codelens.translateFile",
		async (uri: vscode.Uri) => {
			await codeLensTranslateFileCommand(uri);
			codeLensProvider.refresh();
		},
	);
	const codeLensClearFileNeedDisposable = vscode.commands.registerCommand(
		"mdait.codelens.clearFileNeed",
		async (uri: vscode.Uri) => {
			await codeLensClearFileNeedCommand(uri);
			codeLensProvider.refresh();
		},
	);
	const codeLensJumpToSourceFileDisposable = vscode.commands.registerCommand(
		"mdait.codelens.jumpToSourceFile",
		codeLensJumpToSourceFileCommand,
	);
	const codeLensJumpToTargetFileDisposable = vscode.commands.registerCommand(
		"mdait.codelens.jumpToTargetFile",
		codeLensJumpToTargetFileCommand,
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

				const filePath = editor.document.uri.fsPath;
				statusTreeProvider.revealActiveFile(filePath, treeView).catch(() => {
					// reveal失敗はUI上致命的でないため無視（詳細はprovider内でログ済み）
				});
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

	// ツリータイトルの同期ボタン。初回（未同期）とそれ以降でラベルだけを変える
	// （実処理は runSync に一本化。package.json の when 句で排他表示）
	const syncStatusInitialDisposable = vscode.commands.registerCommand("mdait.status.sync.initial", () => runSync());
	const syncStatusDisposable = vscode.commands.registerCommand("mdait.status.sync", () => runSync());

	// status.openTerm command
	const openTermStatusDisposable = vscode.commands.registerCommand("mdait.status.openTerm", openTermCommand);

	// status.openTm command
	const openTmStatusDisposable = vscode.commands.registerCommand("mdait.status.openTm", openTmCommand);

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
		const items = SelectionState.getInstance()
			.getSelectableTargets()
			.map((t) => ({
				label: t.label,
				description: t.description,
				key: t.key,
			}));

		// 絞り込む余地がないときは QuickPick を出さない（1件だけのチェックボックスは意味が伝わらない）
		if (items.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t("No translation targets are configured."));
			return;
		}
		if (items.length === 1) {
			vscode.window.showInformationMessage(
				vscode.l10n.t(
					"Only one translation pair is configured ({0}); there is nothing to filter.",
					items[0].description ?? items[0].label,
				),
			);
			return;
		}

		const pick = vscode.window.createQuickPick<{
			label: string;
			description?: string;
			key: string;
		}>();
		pick.canSelectMany = true;
		pick.title = vscode.l10n.t("Select translation targets to show");
		pick.placeholder = vscode.l10n.t("Check the targets to show in the Status view");
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

			// mdait.jsonの保存を検知して設定を再読み込み
			if (filePath.toLowerCase().endsWith(path.join(".mdait", "mdait.json").toLowerCase())) {
				try {
					await config.initialize();
					logger.info("config", "Configuration reloaded after mdait.json save");
				} catch (error) {
					logger.error("config", "Failed to reload configuration", {
						error: (error as Error).message,
					});
				}
				return;
			}

			// 対象拡張子チェック（.md + config で指定された拡張子）
			const ext = path.extname(filePath).toLowerCase();
			const supportedExtensions = new Set([".md"]);
			if (configInitialized && config.trans.extensions) {
				for (const e of config.trans.extensions) {
					supportedExtensions.add(e.toLowerCase());
				}
			}
			if (!supportedExtensions.has(ext)) {
				return;
			}

			// 設定が有効かチェック
			if (!configInitialized) {
				return;
			}
			if (!config.sync.autoSyncOnSave) {
				return;
			}

			const isMdFile = ext === ".md";

			let shouldSync = false;
			try {
				const fileExplorer = new FileExplorer();
				shouldSync = fileExplorer.isSourceFile(filePath, config) || fileExplorer.isTargetFile(filePath, config);
			} catch (error) {
				logger.warn("extension", "Failed to initialize FileExplorer on save", { error: (error as Error).message });
			}

			if (!shouldSync) {
				const tree = statusManager.getStatusItemTree();
				shouldSync = !!tree.getFile(filePath);
			}

			if (!shouldSync) {
				return;
			}

			// 初期化済みかチェック（まだ一度もsyncしていないファイルは除外）
			try {
				if (isMdFile) {
					// MDファイル: マーカー存在チェックは FileHandler に委譲する。
					// external モードではマーカーが本文でなく unit-state にあり、
					// ここで素の parse をするとマーカー無し扱いになって autoSyncOnSave が沈黙する
					if (!(await getFileHandler(filePath).isInitialized(filePath))) {
						logger.debug("extension", "Skipping file save sync (no mdait markers)", { filePath });
						return;
					}
				} else {
					// 非MDファイル: UnitStateStoreにエントリがあるかチェック
					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (workspaceRoot) {
						const store = UnitStateStore.getInstance();
						const fe = new FileExplorer();
						// ソースファイルの場合は対応するターゲットパスで検索
						let lookupRelPath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
						if (fe.isSourceFile(filePath, config)) {
							const pairs = SelectionState.getInstance().filterTransPairs(config.transPairs);
							for (const pair of pairs) {
								const tgtPath = fe.getTargetPath(filePath, pair);
								if (tgtPath) {
									lookupRelPath = path.relative(workspaceRoot, tgtPath).replace(/\\/g, "/");
									break;
								}
							}
						}
						if (!store.getEntry(lookupRelPath, 0)) {
							logger.debug("extension", "Skipping file save sync (no unit-state entry)", { filePath });
							return;
						}
					}
				}
			} catch (error) {
				logger.warn("extension", "Failed to check initialization on save", {
					error: (error as Error).message,
				});
				return;
			}

			// ファイル保存時に自動的に同期を実行
			await syncSingleFile(filePath);
		} catch (error) {
			logger.warn("extension", "Failed to sync file on save", {
				error: (error as Error).message,
			});
		}
	});

	// LanguageModel Tools 登録
	const getStatusToolDisposable = vscode.lm.registerTool("mdait_getStatus", new MdaitGetStatusTool());
	const syncToolDisposable = vscode.lm.registerTool("mdait_sync", new MdaitSyncTool());
	const translateToolDisposable = vscode.lm.registerTool("mdait_translate", new MdaitTranslateTool());
	const termToolDisposable = vscode.lm.registerTool("mdait_term", new MdaitTermTool());
	const tmToolDisposable = vscode.lm.registerTool("mdait_tm", new MdaitTmTool());
	const validateToolDisposable = vscode.lm.registerTool("mdait_validate", new MdaitValidateTool());
	const aiReviewToolDisposable = vscode.lm.registerTool("mdait_aiReview", new MdaitAiReviewTool());
	const adoptToolDisposable = vscode.lm.registerTool("mdait_adopt", new MdaitAdoptTool());
	const resolveToolDisposable = vscode.lm.registerTool("mdait_resolve", new MdaitResolveTool());

	// 初回データ読み込み
	context.subscriptions.push(
		createConfigDisposable,
		openExistingConfigDisposable,
		openSettingsDisposable,
		settingsEditorProviderDisposable,
		openSettingsAsJsonDisposable,
		openSettingsAsUiDisposable,
		diagnoseSetupDisposable,
		syncDisposable,
		validateDisposable,
		selectTargetsDisposable,
		transDisposable,
		externalizeMarkersDisposable,
		embedMarkersDisposable,
		termDetectDisposable,
		termExpandDisposable,
		addToGlossaryDisposable,
		termDirectoryDisposable,
		termFileDisposable,
		termExpandDirectoryDisposable,
		termExpandFileDisposable,
		codeLensTranslateDisposable,
		codeLensJumpToSourceDisposable,
		codeLensJumpToTargetDisposable,
		codeLensClearNeedDisposable,
		codeLensDeleteUnitDisposable,
		codeLensOtherActionsDisposable,
		editNoteForUnitDisposable,
		codeLensDisposable,
		hoverDisposable,
		translateDirectoryDisposable,
		translatePendingDisposable,
		translateFileDisposable,
		translateUnitDisposable,
		unitMarkReviewedDisposable,
		unitKeepDisposable,
		unitDeleteDisposable,
		unitMarkIsolatedDisposable,
		unitUnisolateDisposable,
		needsAttentionNextDisposable,
		translateSelectionDisposable,
		translateFrontmatterDisposable,
		codeLensClearFrontmatterNeedDisposable,
		codeLensJumpToSourceFrontmatterDisposable,
		codeLensTranslateFileDisposable,
		codeLensClearFileNeedDisposable,
		codeLensJumpToSourceFileDisposable,
		codeLensJumpToTargetFileDisposable,
		tmCommitFileDisposable,
		tmCommitDirectoryDisposable,
		tmOptimizeDisposable,
		aiReviewFileDisposable,
		aiReviewDirectoryDisposable,
		adoptDisposable,
		aiReviewResultCodeLensDisposable,
		saveDisposable,
		treeView,
		syncStatusInitialDisposable,
		syncStatusDisposable,
		openTermStatusDisposable,
		openTmStatusDisposable,
		jumpToUnitDisposable,
		getStatusToolDisposable,
		syncToolDisposable,
		translateToolDisposable,
		termToolDisposable,
		tmToolDisposable,
		validateToolDisposable,
		aiReviewToolDisposable,
		adoptToolDisposable,
		resolveToolDisposable,
	);

	// contextのsubscriptionsに追加することで、自動的にdisposeが呼ばれる
	context.subscriptions.push({
		dispose: () => statusManager.dispose(),
	});

	context.subscriptions.push({
		dispose: () => summaryDecorator.dispose(),
	});

	// OutputChannelもdispose対象に追加
	context.subscriptions.push(outputChannel);

	// デバッグIPCモード: 環境変数またはファイルトリガーで有効化
	// ファイルトリガー (.mdait/debug/.ipc-enabled) を使うことで、
	// 同バージョンのVS Codeが起動中でもmutex転送後にIPCが機能する
	const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (wsRoot) {
		const debugTriggerFile = vscode.Uri.file(`${wsRoot}/.mdait/debug/.ipc-enabled`);
		const ipcEnabled =
			process.env.MDAIT_DEBUG_IPC ||
			(await vscode.workspace.fs.stat(debugTriggerFile).then(
				() => true,
				() => false,
			));
		if (ipcEnabled) {
			const { DebugCommandHandler } = await import("./infra/debug/debug-command-handler.js");
			const debugHandler = new DebugCommandHandler(wsRoot);
			context.subscriptions.push(debugHandler);
			logger.info("debug", "DebugCommandHandler activated (IPC mode)");
		}
	}

	logger.info("extension", "mdait extension activated successfully");
}

/**
 * mdaitConfiguredコンテキスト変数を更新する
 */
async function updateConfiguredContext(config: Configuration): Promise<void> {
	const isConfigured = config.isConfigured();
	await vscode.commands.executeCommand("setContext", "mdaitConfigured", isConfigured);
}

/**
 * mdaitHasStatusコンテキスト変数を更新する
 */
async function updateHasStatusContext(statusManager: StatusManager): Promise<void> {
	const hasStatus = !statusManager.getStatusItemTree().isEmpty();
	await vscode.commands.executeCommand("setContext", "mdaitHasStatus", hasStatus);
}
