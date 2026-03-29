/**
 * @file tm-result-provider.ts
 * @description
 *   tm-commit 完了後の結果プレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で、既存タブを再利用する。
 * @module commands/tm/tm-result-provider
 */
import * as vscode from "vscode";
import type { TmCommitResult, TmResultItem } from "./commit-processor";
import { generateContent } from "./tm-result-content";

export { generateContent } from "./tm-result-content";

const SCHEME = "mdait-tm-result";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:tm-commit-result`);

/**
 * tm-commit 結果の仮想ドキュメントを提供するシングルトン。
 * extension.ts で `workspace.registerTextDocumentContentProvider` に登録して使用する。
 */
export class TmResultContentProvider implements vscode.TextDocumentContentProvider {
	private static instance: TmResultContentProvider;
	private latestContent = "";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this._onDidChange.event;

	private constructor() {}

	static getInstance(): TmResultContentProvider {
		if (!TmResultContentProvider.instance) {
			TmResultContentProvider.instance = new TmResultContentProvider();
		}
		return TmResultContentProvider.instance;
	}

	/** 最新の結果をセットし、既存タブの内容を更新する。 */
	setContent(result: Pick<TmCommitResult, "newItems" | "updatedItems">): void {
		this.latestContent = generateContent(result);
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
