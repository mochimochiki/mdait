/**
 * @file ai-sync-result-provider.ts
 * @description
 *   AI同期（合成コマンド）結果のプレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で既存タブを再利用する
 *   （review-result-provider.ts と同パターン）。
 * @module commands/ai-sync/ai-sync-result-provider
 */
import * as vscode from "vscode";
import { type AiSyncOutcome, generateAiSyncReportContent } from "./ai-sync-result";

const SCHEME = "mdait-ai-sync";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:ai-sync-result`);

/**
 * AI同期結果の仮想ドキュメントを提供するシングルトン。
 * extension.ts で `workspace.registerTextDocumentContentProvider` に登録して使用する。
 */
export class AiSyncResultContentProvider implements vscode.TextDocumentContentProvider {
	private static instance: AiSyncResultContentProvider;
	private latestContent = "";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this._onDidChange.event;

	private constructor() {}

	static getInstance(): AiSyncResultContentProvider {
		if (!AiSyncResultContentProvider.instance) {
			AiSyncResultContentProvider.instance = new AiSyncResultContentProvider();
		}
		return AiSyncResultContentProvider.instance;
	}

	static get scheme(): string {
		return SCHEME;
	}

	/** 最新の結果をセットし、既存タブの内容を更新する。 */
	setContent(outcome: AiSyncOutcome): void {
		this.latestContent = generateAiSyncReportContent(outcome);
		this._onDidChange.fire(PREVIEW_URI);
	}

	provideTextDocumentContent(_uri: vscode.Uri): string {
		return this.latestContent;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	/** プレビュードキュメントを現在のカラムで開く。 */
	static async openPreview(): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(PREVIEW_URI);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: true });
	}
}
