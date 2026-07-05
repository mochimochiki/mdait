/**
 * @file review-result-provider.ts
 * @description
 *   AIペアリング検証結果のプレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で既存タブを再利用する
 *   （tm-result-provider.ts と同パターン）。
 * @module commands/ai-sync/review-result-provider
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { AiReviewFileResult, ReviewAction, UnitReviewResult } from "./review-result";

const SCHEME = "mdait-ai-review";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:ai-review-result`);

/** アクションの表示順（mismatch/partial のエスカレーションを先頭に出す） */
const ACTION_ORDER: Record<ReviewAction, number> = {
	escalated: 0,
	error: 1,
	skipped: 2,
	kept: 3,
	approved: 4,
};

/**
 * 検証結果の Markdown レポートを生成する（純関数・テスト可能）。
 * 自動承認されたユニットも必ず列挙する（ADR-260704-07）。
 */
export function generateReviewReportContent(results: AiReviewFileResult[]): string {
	const lines: string[] = ["# mdait AI Pairing Review", ""];

	const totals = results.reduce(
		(acc, r) => {
			acc.verified += r.verified;
			acc.approved += r.approved;
			acc.escalated += r.escalated;
			acc.kept += r.kept;
			acc.skipped += r.skipped;
			acc.errors += r.errors;
			return acc;
		},
		{ verified: 0, approved: 0, escalated: 0, kept: 0, skipped: 0, errors: 0 },
	);
	lines.push(
		`verified: ${totals.verified} | approved: ${totals.approved} | escalated: ${totals.escalated} | kept: ${totals.kept} | skipped: ${totals.skipped} | errors: ${totals.errors}`,
		"",
	);

	for (const fileResult of results) {
		if (fileResult.unitResults.length === 0) {
			continue;
		}
		lines.push(`## ${path.basename(fileResult.filePath)}`, "", fileResult.filePath, "");
		lines.push("| action | verdict | confidence | unit | reason |");
		lines.push("|---|---|---|---|---|");

		const sorted = [...fileResult.unitResults].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]);
		for (const unit of sorted) {
			lines.push(
				`| ${formatAction(unit)} | ${unit.verdict ?? "-"} | ${unit.confidence !== undefined ? unit.confidence.toFixed(2) : "-"} | ${escapeCell(unit.title ?? unit.unitHash)} | ${escapeCell(formatReason(unit))} |`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function formatAction(unit: UnitReviewResult): string {
	switch (unit.action) {
		case "escalated":
			return unit.verdict === "mismatch" ? "⚠️ escalated" : "🔶 escalated";
		case "error":
			return "❌ error";
		case "skipped":
			return "⏭️ skipped";
		case "kept":
			return "⏸️ kept";
		case "approved":
			return "✅ approved";
	}
}

function formatReason(unit: UnitReviewResult): string {
	const parts: string[] = [];
	if (unit.reason) {
		parts.push(unit.reason);
	}
	if (unit.issues.length > 0) {
		parts.push(unit.issues.join("; "));
	}
	return parts.join(" | ");
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

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
