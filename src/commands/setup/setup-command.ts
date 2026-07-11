import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";

/**
 * 既存のmdait.jsonを選択してカスタムパスとして登録するコマンド
 * @param context VS Code ExtensionContext (workspaceState への保存に使用)
 */
export async function openExistingConfigCommand(
	context: vscode.ExtensionContext,
): Promise<void> {
	const result = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFolders: false,
		filters: { JSON: ["json"] },
		title: vscode.l10n.t("Select mdait.json"),
	});

	if (!result || result.length === 0) {
		return;
	}

	const selectedPath = result[0].fsPath;

	try {
		const config = Configuration.getInstance();
		await config.initialize(selectedPath);

		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("Invalid configuration: {0}", validationError),
			);
			return;
		}

		await context.workspaceState.update("mdait.configPath", selectedPath);
		await vscode.commands.executeCommand("setContext", "mdaitConfigured", true);
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t(
				"Failed to load configuration: {0}",
				(error as Error).message,
			),
		);
	}
}

/**
 * mdait.json設定ファイルのテンプレートを作成するコマンド（中核プロセス）
 * @param context VS Code ExtensionContext (拡張機能のパスを取得するため)
 */
export async function createConfigCommand(
	context: vscode.ExtensionContext,
): Promise<void> {
	// ワークスペースの確認
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceFolder) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("No workspace folder is open."),
		);
		return;
	}

	const configPath = path.join(workspaceFolder, ".mdait", "mdait.json");

	// 既存ファイルのチェック
	if (fs.existsSync(configPath)) {
		const overwrite = await vscode.window.showWarningMessage(
			vscode.l10n.t("mdait.json already exists. Do you want to open it?"),
			vscode.l10n.t("Open"),
			vscode.l10n.t("Cancel"),
		);
		if (overwrite === vscode.l10n.t("Open")) {
			const document = await vscode.workspace.openTextDocument(configPath);
			await vscode.window.showTextDocument(document);
		}
		return;
	}

	// 拡張機能にバンドルされているmdait.template.jsonを読み込む
	let templateContent: string;
	const bundledTemplatePath = path.join(
		context.extensionPath,
		"assets/mdait.template.json",
	);

	if (fs.existsSync(bundledTemplatePath)) {
		templateContent = fs.readFileSync(bundledTemplatePath, "utf8");
	} else {
		// フォールバック: 拡張機能のテンプレートファイルが見つからない場合はエラー
		vscode.window.showErrorMessage(
			vscode.l10n.t(
				"Template file not found in extension. Please reinstall the extension.",
			),
		);
		return;
	}

	try {
		// .mdait ディレクトリを作成（存在しない場合）、.gitignore も自動生成
		await ensureMdaitDir();

		// mdait.jsonを作成
		fs.writeFileSync(configPath, templateContent, "utf8");

		// 作成したファイルをエディタで開く
		const document = await vscode.workspace.openTextDocument(configPath);
		await vscode.window.showTextDocument(document);

		// Configurationインスタンスを再初期化して設定を読み込む
		try {
			await Configuration.getInstance().initialize();
		} catch (error) {
			// 初期化に失敗してもエラーは表示しない（ユーザーがまだ編集中の可能性があるため）
			console.log(
				"mdait: Configuration initialization deferred:",
				(error as Error).message,
			);
		}

		// コンテキスト変数を更新（設定ファイルが作成されたことを通知）
		await vscode.commands.executeCommand("setContext", "mdaitConfigured", true);

		// 成功メッセージを表示（保存前の誤操作を防ぐため実行ボタンは付けず、
		// 状態駆動の Welcome ビューが次の一歩（初回同期 / 取り込み）へ誘導する）
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"Created mdait.json. Configure transPairs and save — then run Initial Sync, or Adopt Existing Translations if your documents are already translated.",
			),
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t(
				"Failed to create mdait.json: {0}",
				(error as Error).message,
			),
		);
	}
}
