/**
 * @file adopt-result-provider.ts
 * @description
 *   取り込みウィザードの統合レポートのプレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で既存タブを再利用する
 *   （review-result-provider.ts と同パターン）。
 * @module commands/adopt/adopt-result-provider
 */
import * as vscode from "vscode";
import { type AdoptOutcome, generateAdoptReportContent } from "./adopt-result";

const SCHEME = "mdait-adopt";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:adopt-result`);

/**
 * 取り込み結果の仮想ドキュメントを提供するシングルトン。
 * extension.ts で `workspace.registerTextDocumentContentProvider` に登録して使用する。
 */
export class AdoptResultContentProvider implements vscode.TextDocumentContentProvider {
	private static instance: AdoptResultContentProvider;
	private latestContent = "";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this._onDidChange.event;

	private constructor() {}

	static getInstance(): AdoptResultContentProvider {
		if (!AdoptResultContentProvider.instance) {
			AdoptResultContentProvider.instance = new AdoptResultContentProvider();
		}
		return AdoptResultContentProvider.instance;
	}

	static get scheme(): string {
		return SCHEME;
	}

	/** 最新の結果をセットし、既存タブの内容を更新する。 */
	setContent(outcome: AdoptOutcome): void {
		this.latestContent = generateAdoptReportContent(outcome);
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
