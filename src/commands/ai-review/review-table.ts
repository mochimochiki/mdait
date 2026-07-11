/**
 * @file review-table.ts
 * @description
 *   AIペアリング検証結果の Markdown レポート/表を生成する純関数群。
 *   **VS Code API 非依存**（node:path のみ）。仮想ドキュメント（review-result-provider）と
 *   取り込みウィザードの統合レポート（adopt-result）の両方から再利用され、単体テストも VS Code 抜きで行える。
 * @module commands/ai-review/review-table
 */
import * as path from "node:path";
import type { AiReviewFileResult, ReviewAction, UnitReviewResult } from "./review-result";

/** アクションの表示順（ドリフト検出＝flagged/escalated を先頭に出す） */
const ACTION_ORDER: Record<ReviewAction, number> = {
	flagged: 0,
	escalated: 1,
	error: 2,
	skipped: 3,
	kept: 4,
	audited: 5,
	approved: 6,
};

/**
 * レポート内で「note を編集できるユニット行」の位置情報。
 * 仮想ドキュメント（review-result-provider）の CodeLens が
 * flagged 行から該当ユニットの note 編集へジャンプするために使う。
 */
export interface ReportAnchor {
	/** レポート内の 0 始まり行番号（そのユニットのテーブル行） */
	line: number;
	/** 対象ターゲットファイルの絶対パス */
	filePath: string;
	/** ユニットの hash（note のキー） */
	unitHash: string;
	/** 表示用タイトル */
	title: string;
}

/**
 * 検証結果の Markdown レポートを生成する（純関数・テスト可能）。
 * 自動承認されたユニットも必ず列挙する（ADR-260704-07）。
 */
export function generateReviewReportContent(results: AiReviewFileResult[]): string {
	return buildReviewReport(results).content;
}

/**
 * 検証結果レポートを生成し、あわせて flagged 行の位置（アンカー）を返す。
 * アンカーは仮想ドキュメントの CodeLens が「note 編集へジャンプ」を出すために使う。
 */
export function buildReviewReport(results: AiReviewFileResult[]): { content: string; anchors: ReportAnchor[] } {
	const lines: string[] = ["# mdait AI Pairing Review", ""];

	const totals = results.reduce(
		(acc, r) => {
			acc.verified += r.verified;
			acc.approved += r.approved;
			acc.flagged += r.flagged;
			acc.audited += r.audited;
			acc.escalated += r.escalated;
			acc.kept += r.kept;
			acc.skipped += r.skipped;
			acc.errors += r.errors;
			return acc;
		},
		{ verified: 0, approved: 0, flagged: 0, audited: 0, escalated: 0, kept: 0, skipped: 0, errors: 0 },
	);
	lines.push(
		`verified: ${totals.verified} | approved: ${totals.approved} | flagged: ${totals.flagged} | escalated: ${totals.escalated} | audited: ${totals.audited} | kept: ${totals.kept} | skipped: ${totals.skipped} | errors: ${totals.errors}`,
		"",
	);
	const anchors: ReportAnchor[] = [];
	for (const fileResult of results) {
		appendFileTable(lines, fileResult, anchors);
	}

	return { content: lines.join("\n"), anchors };
}

/**
 * ファイルごとの検証結果テーブルを生成する（純関数・テスト可能）。
 * 取り込みウィザードの統合レポート（adopt-result）からも再利用する。
 * unitResults が空のファイルはスキップし、mismatch/partial を先頭に並べる。
 */
export function generateReviewTableSection(results: AiReviewFileResult[]): string {
	const lines: string[] = [];
	for (const fileResult of results) {
		appendFileTable(lines, fileResult);
	}
	return lines.join("\n");
}

/**
 * 1ファイル分のテーブルを lines に追記する。
 * anchors を渡すと、flagged 行の行番号（絶対）を記録する。
 */
function appendFileTable(lines: string[], fileResult: AiReviewFileResult, anchors?: ReportAnchor[]): void {
	if (fileResult.unitResults.length === 0) {
		return;
	}
	lines.push(`## ${path.basename(fileResult.filePath)}`, "", fileResult.filePath, "");
	lines.push("| action | verdict | confidence | unit | reason |");
	lines.push("|---|---|---|---|---|");

	const sorted = [...fileResult.unitResults].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]);
	for (const unit of sorted) {
		const lineIndex = lines.length;
		lines.push(
			`| ${formatAction(unit)} | ${unit.verdict ?? "-"} | ${unit.confidence !== undefined ? unit.confidence.toFixed(2) : "-"} | ${escapeCell(unit.title ?? unit.unitHash)} | ${escapeCell(formatReason(unit))} |`,
		);
		if (anchors && unit.action === "flagged" && unit.unitHash) {
			anchors.push({
				line: lineIndex,
				filePath: fileResult.filePath,
				unitHash: unit.unitHash,
				title: unit.title ?? unit.unitHash,
			});
		}
	}
	lines.push("");
}

function formatAction(unit: UnitReviewResult): string {
	switch (unit.action) {
		case "flagged":
			return unit.verdict === "mismatch" ? "⚠️ flagged" : "🔶 flagged";
		case "escalated":
			return unit.verdict === "mismatch" ? "⚠️ escalated" : "🔶 escalated";
		case "error":
			return "❌ error";
		case "skipped":
			return "⏭️ skipped";
		case "kept":
			return "⏸️ kept";
		case "audited":
			return "🔍 audited";
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
