/**
 * @file term-result-provider.ts
 * @description
 *   term-detect 完了後の結果プレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で、既存タブを再利用する。
 * @module commands/term/term-result-provider
 */
import * as vscode from "vscode";
import type { TermEntry } from "./term-entry";

const SCHEME = "mdait-term-result";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:term-detect-result`);

/** term-detect 結果をまとめた型 */
export interface TermDetectResult {
	readonly entries: readonly TermEntry[];
	readonly sourceLang: string;
	readonly targetLang: string;
}

/**
 * term-detect 結果の仮想ドキュメントを提供するシングルトン。
 * extension.ts で `workspace.registerTextDocumentContentProvider` に登録して使用する。
 */
export class TermResultContentProvider implements vscode.TextDocumentContentProvider {
	private static instance: TermResultContentProvider;
	private latestContent = "";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this._onDidChange.event;

	private constructor() {}

	static getInstance(): TermResultContentProvider {
		if (!TermResultContentProvider.instance) {
			TermResultContentProvider.instance = new TermResultContentProvider();
		}
		return TermResultContentProvider.instance;
	}

	/** 最新の結果をセットし、既存タブの内容を更新する。 */
	setContent(result: TermDetectResult): void {
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

const TARGET_NOT_DETECTED = "(target not detected)";

/**
 * term-detect 結果からプレビュー用テキストを生成する純粋関数。
 */
export function generateContent(result: TermDetectResult): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# Term Detect Results - ${timestamp}`);
	lines.push("");

	lines.push(`## Detected (${result.entries.length})`);
	if (result.entries.length === 0) {
		lines.push("(none)");
		lines.push("");
	} else {
		for (const entry of result.entries) {
			const sourceTerm = entry.languages[result.sourceLang]?.term;
			lines.push(`"${sourceTerm ?? ""}"`);

			const targetTerm = entry.languages[result.targetLang]?.term;
			if (targetTerm) {
				lines.push(`  \u2192 "${targetTerm}"`);
			} else {
				lines.push(`  ${TARGET_NOT_DETECTED}`);
			}

			if (entry.context) {
				lines.push(`  context: ${entry.context}`);
			}

			lines.push("");
		}
	}

	return lines.join("\n");
}
