/**
 * @file review-result-provider.ts
 * @description
 *   AIペアリング検証結果のプレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で既存タブを再利用する
 *   （tm-result-provider.ts と同パターン）。レポート本文の生成は VS Code 非依存の
 *   review-table.ts に委譲する。
 * @module commands/ai-sync/review-result-provider
 */
import * as vscode from "vscode";
import type { AiReviewFileResult } from "./review-result";
import { generateReviewReportContent } from "./review-table";

const SCHEME = "mdait-ai-review";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:ai-review-result`);

/**
 * AIペアリング検証結果の仮想ドキュメントを提供するシングルトン。
 * extension.ts で `workspace.registerTextDocumentContentProvider` に登録して使用する。
 */
export class AiReviewResultContentProvider implements vscode.TextDocumentContentProvider {
	private static instance: AiReviewResultContentProvider;
	private latestContent = "";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this._onDidChange.event;

	private constructor() {}

	static getInstance(): AiReviewResultContentProvider {
		if (!AiReviewResultContentProvider.instance) {
			AiReviewResultContentProvider.instance = new AiReviewResultContentProvider();
		}
		return AiReviewResultContentProvider.instance;
	}

	/** 最新の結果をセットし、既存タブの内容を更新する。 */
	setContent(results: AiReviewFileResult[]): void {
		this.latestContent = generateReviewReportContent(results);
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
