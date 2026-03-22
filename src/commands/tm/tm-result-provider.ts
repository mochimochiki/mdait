/**
 * @file tm-result-provider.ts
 * @description
 *   tm-commit 完了後の結果プレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で、既存タブを再利用する。
 * @module commands/tm/tm-result-provider
 */
import * as vscode from "vscode";
import type { TmCommitResult, TmResultItem } from "./commit-processor";

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

/**
 * tm-commit 結果からプレビュー用テキストを生成する純粋関数。
 */
export function generateContent(result: { newItems: TmResultItem[]; updatedItems: TmResultItem[] }): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# TM Commit Results - ${timestamp}`);
	lines.push("");

	lines.push(`## New (${result.newItems.length})`);
	if (result.newItems.length === 0) {
		lines.push("(none)");
		lines.push("");
	} else {
		for (const item of result.newItems) {
			lines.push(`"${item.primary}"`);
			lines.push(`  \u2192 "${item.local}"`);
			lines.push("");
		}
	}

	lines.push(`## Updated (${result.updatedItems.length})`);
	if (result.updatedItems.length === 0) {
		lines.push("(none)");
		lines.push("");
	} else {
		for (const item of result.updatedItems) {
			lines.push(`"${item.primary}"`);
			lines.push(`  \u2192 "${item.local}"`);
			lines.push("");
		}
	}

	return lines.join("\n");
}
