import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { StatusCollector } from "./commands/file-handler/status-collector";
import { createConfigCommand } from "./commands/setup/setup-command";
import { syncCommand, syncSingleFile } from "./commands/sync/sync-command";
import { addToGlossaryCommand } from "./commands/term/command-add";
import { detectTermCommand } from "./commands/term/command-detect";
import { expandTermCommand } from "./commands/term/command-expand";
import { openTermCommand } from "./commands/term/command-open";
import { StatusTreeTermHandler } from "./commands/term/status-tree-term-handler";
import { TermResultContentProvider } from "./commands/term/term-result-provider";
import {
	tmCommitDirectoryCommand,
	tmCommitFileCommand,
} from "./commands/tm/command-commit";
import { openTmCommand } from "./commands/tm/command-open";
import { tmOptimizeCommand } from "./commands/tm/command-optimize";
import { TmResultContentProvider } from "./commands/tm/tm-result-provider";
import { translateSelectionCommand } from "./commands/trans-selection/trans-selection-command";
import { StatusTreeTranslationHandler } from "./commands/trans/status-tree-translation-handler";
import {
	transCommand,
	translateFrontmatterCommand,
} from "./commands/trans/trans-command";
import { FileStateStore } from "./core/file-state/file-state-store";
import { parseFrontmatterMarker } from "./core/markdown/frontmatter-translation";
import { markdownParser } from "./core/markdown/parser";
import { SelectionState } from "./core/status/selection-state";
import {
	type StatusItem,
	isFrontmatterStatusItem,
} from "./core/status/status-item";
import { StatusManager } from "./core/status/status-manager";
import { Configuration } from "./infra/config/configuration";
import { Logger, parseLogLevel } from "./infra/logging/logger";
import { AIOnboarding } from "./infra/onboarding/ai-onboarding";
import { FileExplorer } from "./infra/workspace/file-explorer";
import { MdaitGetStatusTool } from "./lm-tools/get-status-tool";
import { MdaitSyncTool } from "./lm-tools/sync-tool";
import { MdaitTranslateTool } from "./lm-tools/translate-tool";
import {
	codeLensClearFrontmatterNeedCommand,
	codeLensClearNeedCommand,
	codeLensJumpToSourceCommand,
	codeLensJumpToSourceFrontmatterCommand,
	codeLensJumpToTargetCommand,
	codeLensTranslateCommand,
} from "./ui/codelens/codelens-command";
import { MdaitCodeLensProvider } from "./ui/codelens/codelens-provider";
import { SummaryDecorator } from "./ui/hover/summary-decorator";
import { SummaryManager } from "./ui/hover/summary-manager";
import { TranslationSummaryHoverProvider } from "./ui/hover/translation-summary-hover-provider";
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
		await config.initialize();
		configInitialized = true;
		logger.info("config", "Configuration loaded successfully");

		// FileStateStoreの起動時ロード（非MDファイルの翻訳状態を即座に利用可能にする）
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (wsRoot) {
			const mdaitDir = path.join(wsRoot, ".mdait");
			if (fs.existsSync(mdaitDir)) {
				FileStateStore.getInstance().ensureLoaded(mdaitDir);
			}
		}
	} catch (error) {
		// 設定ファイルがない場合はエラーを表示せず、Welcome Viewを表示するため続行
		logger.info("config", "Configuration not loaded", {
			reason: (error as Error).message,
		});
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
	selectionState.initialize(context).then(() => {
		// 初期化後に transPairs と整合
		selectionState.reconcileWith(config.transPairs);
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
				const newLogLevel = vscode.workspace
					.getConfiguration("mdait")
					.get<string>("logLevel", "INFO");
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
	const createConfigDisposable = vscode.commands.registerCommand(
		"mdait.setup.createConfig",
		() => createConfigCommand(context),
	);

	// sync command
	const syncDisposable = vscode.commands.registerCommand(
		"mdait.sync",
		syncCommand,
	);

	// trans command
	const transDisposable = vscode.commands.registerCommand(
		"mdait.trans",
		transCommand,
	);

	// Trans handler
	const translateItemCommand = new StatusTreeTranslationHandler();
	translateItemCommand.setStatusTreeProvider(statusTreeProvider);

	const translateDirectoryDisposable = vscode.commands.registerCommand(
		"mdait.translate.directory",
		(item) => translateItemCommand.translateDirectory(item),
	);
	const translateFileDisposable = vscode.commands.registerCommand(
		"mdait.translate.file",
		(item) => translateItemCommand.translateFile(item),
	);
	const translateUnitDisposable = vscode.commands.registerCommand(
		"mdait.translate.unit",
		(item) => translateItemCommand.translateUnit(item),
	);

	// term.detect command
	const termDetectDisposable = vscode.commands.registerCommand(
		"mdait.term.detect",
		detectTermCommand,
	);

	// term.expand command
	const termExpandDisposable = vscode.commands.registerCommand(
		"mdait.term.expand",
		(item) => expandTermCommand(item as StatusItem),
	);

	// term.open command
	const termOpenDisposable = vscode.commands.registerCommand(
		"mdait.term.open",
		openTermCommand,
	);

	// term.addToGlossary command
	const addToGlossaryDisposable = vscode.commands.registerCommand(
		"mdait.addToGlossary",
		addToGlossaryCommand,
	);

	// Term handler
	const termHandler = new StatusTreeTermHandler();
	termHandler.setStatusTreeProvider(statusTreeProvider);

	const termDirectoryDisposable = vscode.commands.registerCommand(
		"mdait.term.detect.directory",
		(item) => termHandler.termDetectDirectory(item as StatusItem),
	);
	const termFileDisposable = vscode.commands.registerCommand(
		"mdait.term.detect.file",
		(item) => termHandler.termDetectFile(item as StatusItem),
	);

	// term.expand.directory/file commands
	const termExpandDirectoryDisposable = vscode.commands.registerCommand(
		"mdait.term.expand.directory",
		(item) => termHandler.termExpandDirectory(item as StatusItem),
	);
	const termExpandFileDisposable = vscode.commands.registerCommand(
		"mdait.term.expand.file",
		(item) => termHandler.termExpandFile(item as StatusItem),
	);

	// Translate Selection command
	const translateSelectionDisposable = vscode.commands.registerCommand(
		"mdait.translateSelection",
		translateSelectionCommand,
	);

	// TM Commit commands
	const tmCommitFileDisposable = vscode.commands.registerCommand(
		"mdait.tm.commit.file",
		(item?: StatusItem) => tmCommitFileCommand(item),
	);
	const tmCommitDirectoryDisposable = vscode.commands.registerCommand(
		"mdait.tm.commit.directory",
		(item?: StatusItem) => tmCommitDirectoryCommand(item),
	);
	const tmOptimizeDisposable = vscode.commands.registerCommand(
		"mdait.tm.optimize",
		tmOptimizeCommand,
	);

	// TM Result ContentProvider登録
	const tmResultProvider = TmResultContentProvider.getInstance();
	const tmResultProviderDisposable =
		vscode.workspace.registerTextDocumentContentProvider(
			"mdait-tm-result",
			tmResultProvider,
		);

	// Term Result ContentProvider登録
	const termResultProvider = TermResultContentProvider.getInstance();
	const termResultProviderDisposable =
		vscode.workspace.registerTextDocumentContentProvider(
			"mdait-term-result",
			termResultProvider,
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
	const codeLensClearFrontmatterNeedDisposable =
		vscode.commands.registerCommand(
			"mdait.codelens.clearFrontmatterNeed",
			codeLensClearFrontmatterNeedCommand,
		);

	// CodeLens ソースFrontmatterジャンプコマンド
	const codeLensJumpToSourceFrontmatterDisposable =
		vscode.commands.registerCommand(
			"mdait.codelens.jumpToSourceFrontmatter",
			codeLensJumpToSourceFrontmatterCommand,
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

				const filePath = editor.document.uri.fsPath;
				statusTreeProvider.revealActiveFile(filePath, treeView);
			}
		},
		null,
		context.subscriptions,
	);

	// ドキュメント変更時にDecorationを更新（保存時など）
	vscode.workspace.onDidChangeTextDocument(
		(event) => {
			const editor = vscode.window.activeTextEditor;
			if (
				editor &&
				event.document === editor.document &&
				editor.document.languageId === "markdown"
			) {
				summaryDecorator.updateDecorations(editor);
			}
		},
		null,
		context.subscriptions,
	);

	// status.sync.initial command（初回同期）
	const syncStatusInitialDisposable = vscode.commands.registerCommand(
		"mdait.status.sync.initial",
		async () => {
			try {
				await vscode.commands.executeCommand(
					"setContext",
					"mdaitSyncProcessing",
					true,
				);
				await syncCommand();
				// StatusManagerから初期化されたStatusTreeProviderのrefreshを呼ぶ
				await statusManager.buildStatusItemTree();
			} catch (error) {
				vscode.window.showErrorMessage(
					vscode.l10n.t(
						"Failed to sync and refresh: {0}",
						(error as Error).message,
					),
				);
			} finally {
				await vscode.commands.executeCommand(
					"setContext",
					"mdaitSyncProcessing",
					false,
				);
			}
		},
	);

	// status.sync command（通常同期）
	const syncStatusDisposable = vscode.commands.registerCommand(
		"mdait.status.sync",
		async () => {
			try {
				await vscode.commands.executeCommand(
					"setContext",
					"mdaitSyncProcessing",
					true,
				);
				await syncCommand();
				// StatusManagerから初期化されたStatusTreeProviderのrefreshを呼ぶ
				await statusManager.buildStatusItemTree();
			} catch (error) {
				vscode.window.showErrorMessage(
					vscode.l10n.t(
						"Failed to sync and refresh: {0}",
						(error as Error).message,
					),
				);
			} finally {
				await vscode.commands.executeCommand(
					"setContext",
					"mdaitSyncProcessing",
					false,
				);
			}
		},
	);

	// status.openTerm command
	const openTermStatusDisposable = vscode.commands.registerCommand(
		"mdait.status.openTerm",
		openTermCommand,
	);

	// status.openTm command
	const openTmStatusDisposable = vscode.commands.registerCommand(
		"mdait.status.openTm",
		openTmCommand,
	);

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
				editor.revealRange(
					new vscode.Range(position, position),
					vscode.TextEditorRevealType.InCenter,
				);
			} catch (error) {
				vscode.window.showErrorMessage(
					vscode.l10n.t(
						"Failed to jump to unit: {0}",
						(error as Error).message,
					),
				);
			}
		},
	);

	// 対象言語選択コマンド（QuickPick: 複数選択、空は確定不可）
	const selectTargetsDisposable = vscode.commands.registerCommand(
		"mdait.status.selectTargets",
		async () => {
			const pick = vscode.window.createQuickPick<{
				label: string;
				description?: string;
				key: string;
			}>();
			pick.canSelectMany = true;
			const items = SelectionState.getInstance()
				.getSelectableTargets()
				.map((t) => ({
					label: t.label,
					description: t.description,
					key: t.key,
				}));
			pick.items = items;
			// 既存選択を反映
			const selectedKeys = Array.from(
				SelectionState.getInstance().getActiveKeys(),
			);
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
		},
	);

	// ドキュメント保存時のステータス更新
	const saveDisposable = vscode.workspace.onDidSaveTextDocument(
		async (document) => {
			try {
				if (document.uri.scheme !== "file") {
					return;
				}
				const filePath = document.uri.fsPath;

				// mdait.jsonの保存を検知して設定を再読み込み
				if (
					filePath
						.toLowerCase()
						.endsWith(path.join(".mdait", "mdait.json").toLowerCase())
				) {
					try {
						await config.initialize();
						logger.info(
							"config",
							"Configuration reloaded after mdait.json save",
						);
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
					shouldSync =
						fileExplorer.isSourceFile(filePath, config) ||
						fileExplorer.isTargetFile(filePath, config);
				} catch (error) {
					logger.warn(
						"extension",
						"Failed to initialize FileExplorer on save",
						{ error: (error as Error).message },
					);
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
						// MDファイル: mdaitマーカーの存在チェック
						const fileDocument = await vscode.workspace.fs.readFile(
							vscode.Uri.file(filePath),
						);
						const decoder = new TextDecoder("utf-8");
						const content = decoder.decode(fileDocument);
						const parsed = markdownParser.parse(content, config);

						const hasUnitMarker = parsed.units.some(
							(unit) => unit.marker.hash !== null,
						);
						const hasFrontmatterMarker = parsed.frontMatter
							? parseFrontmatterMarker(parsed.frontMatter) !== null
							: false;

						if (!hasUnitMarker && !hasFrontmatterMarker) {
							logger.debug(
								"extension",
								"Skipping file save sync (no mdait markers)",
								{ filePath },
							);
							return;
						}
					} else {
						// 非MDファイル: FileStateStoreにエントリがあるかチェック
						const workspaceRoot =
							vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
						if (workspaceRoot) {
							const relPath = path
								.relative(workspaceRoot, filePath)
								.replace(/\\/g, "/");
							const store = FileStateStore.getInstance();
							if (!store.getEntry(relPath)) {
								logger.debug(
									"extension",
									"Skipping file save sync (no file-state entry)",
									{ filePath },
								);
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
		},
	);

	// LanguageModel Tools 登録
	const getStatusToolDisposable = vscode.lm.registerTool(
		"mdait_getStatus",
		new MdaitGetStatusTool(),
	);
	const syncToolDisposable = vscode.lm.registerTool(
		"mdait_sync",
		new MdaitSyncTool(),
	);
	const translateToolDisposable = vscode.lm.registerTool(
		"mdait_translate",
		new MdaitTranslateTool(),
	);

	// 初回データ読み込み
	context.subscriptions.push(
		createConfigDisposable,
		syncDisposable,
		selectTargetsDisposable,
		transDisposable,
		termDetectDisposable,
		termExpandDisposable,
		termOpenDisposable,
		addToGlossaryDisposable,
		termDirectoryDisposable,
		termFileDisposable,
		termExpandDirectoryDisposable,
		termExpandFileDisposable,
		codeLensTranslateDisposable,
		codeLensJumpToSourceDisposable,
		codeLensJumpToTargetDisposable,
		codeLensClearNeedDisposable,
		codeLensDisposable,
		hoverDisposable,
		translateDirectoryDisposable,
		translateFileDisposable,
		translateUnitDisposable,
		translateSelectionDisposable,
		translateFrontmatterDisposable,
		codeLensClearFrontmatterNeedDisposable,
		codeLensJumpToSourceFrontmatterDisposable,
		tmCommitFileDisposable,
		tmCommitDirectoryDisposable,
		tmOptimizeDisposable,
		tmResultProviderDisposable,
		tmResultProvider,
		termResultProviderDisposable,
		termResultProvider,
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
		const debugTriggerFile = vscode.Uri.file(
			`${wsRoot}/.mdait/debug/.ipc-enabled`,
		);
		const ipcEnabled =
			process.env.MDAIT_DEBUG_IPC ||
			(await vscode.workspace.fs.stat(debugTriggerFile).then(
				() => true,
				() => false,
			));
		if (ipcEnabled) {
			const { DebugCommandHandler } = await import(
				"./infra/debug/debug-command-handler.js"
			);
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
	await vscode.commands.executeCommand(
		"setContext",
		"mdaitConfigured",
		isConfigured,
	);
}

/**
 * mdaitHasStatusコンテキスト変数を更新する
 */
async function updateHasStatusContext(
	statusManager: StatusManager,
): Promise<void> {
	const hasStatus = !statusManager.getStatusItemTree().isEmpty();
	await vscode.commands.executeCommand(
		"setContext",
		"mdaitHasStatus",
		hasStatus,
	);
}
