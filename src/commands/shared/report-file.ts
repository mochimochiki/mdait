/**
 * @file report-file.ts
 * @description
 *   各コマンドの実行レポートを `.mdait/reports/` 配下の Markdown 実ファイルとして書き出し、
 *   完了通知のボタンから開くための共通経路。
 *
 *   **レポートの出し方を各コマンドで実装しないこと。** 以前は adopt だけが実ファイル、
 *   term / tm / ai-review が仮想ドキュメント（ほぼ同一のコピー3本）、doctor が untitled と
 *   4方式に分かれ、行リンクが使えるのも再読み込みで消えないのも adopt だけだった。
 *
 *   実ファイルにすると、プレビュー・該当箇所への行リンク・git 差分という VS Code / git の
 *   標準機能がそのまま使える。実行ごとに上書きし、履歴は git に委ねる（ADR-260719-01）。
 * @module commands/shared/report-file
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";

const logger = Logger.getInstance();

/** レポートの種類。ファイル名 `<kind>.md` になる */
export type ReportKind = "adopt" | "ai-review" | "term" | "tm" | "doctor";

/**
 * レポートを `.mdait/reports/<kind>.md` へ書き出す。
 *
 * **レポートの書き出しが `.mdait/` を新規作成することはない。** まだ mdait 化されていない
 * ワークスペースでは書かずに undefined を返す（セットアップ診断は未設定のワークスペースでも
 * 走るため、診断しただけでディレクトリが増えると驚きになる）。mdait 管理下のコマンドは
 * 本処理の中で既に `.mdait/` を用意しているので、この制約で困ることはない。
 *
 * @returns 書き出したファイルの URI（書けなかった場合は undefined。レポートの失敗で
 *   コマンド本体を失敗扱いにしないため、例外は投げずに undefined を返す）
 */
export async function writeReport(
	config: Configuration,
	kind: ReportKind,
	content: string,
): Promise<vscode.Uri | undefined> {
	try {
		if (!fs.existsSync(config.getMdaitDir())) {
			return undefined;
		}
		const reportsDir = config.getReportsDir();
		if (!fs.existsSync(reportsDir)) {
			fs.mkdirSync(reportsDir, { recursive: true });
		}
		const uri = vscode.Uri.file(config.getReportFilePath(kind));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		return uri;
	} catch (error) {
		logger.warn("report", "Failed to write report", { kind, ...formatError(error) });
		return undefined;
	}
}

/**
 * レポートを Markdown プレビューで開く（行リンクを踏めるようにするため）。
 * プレビューが使えない環境ではテキストとして開く。
 */
export async function openReport(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.commands.executeCommand("markdown.showPreview", uri);
	} catch (error) {
		logger.warn("report", "Failed to open report preview", formatError(error));
		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch (fallbackError) {
			logger.warn("report", "Failed to open report", formatError(fallbackError));
		}
	}
}

/**
 * 完了通知に「レポートを開く」ボタンを添えて表示する。
 *
 * レポートを自動で開かないのは、実ファイルなのでいつでも開き直せるからである
 * （毎回自動で開くとタブが増え続ける。ux.md E-6）。
 *
 * @param message 通知本文
 * @param uri レポートの URI。undefined ならボタンを出さない
 * @param severity warning のときは警告として出す
 */
export function notifyWithReport(
	message: string,
	uri: vscode.Uri | undefined,
	severity: "info" | "warning" = "info",
): void {
	const show = severity === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
	if (!uri) {
		void show(message);
		return;
	}
	const openLabel = vscode.l10n.t("Open report");
	void show(message, openLabel).then(
		(choice) => (choice === openLabel ? openReport(uri) : undefined),
		(error) => logger.warn("report", "Report notification failed", formatError(error)),
	);
}
