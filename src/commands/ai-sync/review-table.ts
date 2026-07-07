/**
 * @file review-table.ts
 * @description
 *   AIペアリング検証結果の Markdown レポート/表を生成する純関数群。
 *   **VS Code API 非依存**（node:path のみ）。仮想ドキュメント（review-result-provider）と
 *   AI同期の合成レポート（ai-sync-result）の両方から再利用され、単体テストも VS Code 抜きで行える。
 * @module commands/ai-sync/review-table
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
	accepted: 6,
	approved: 7,
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
			acc.flagged += r.flagged;
			acc.accepted += r.accepted;
			acc.audited += r.audited;
			acc.escalated += r.escalated;
			acc.kept += r.kept;
			acc.skipped += r.skipped;
			acc.errors += r.errors;
			return acc;
		},
		{ verified: 0, approved: 0, flagged: 0, accepted: 0, audited: 0, escalated: 0, kept: 0, skipped: 0, errors: 0 },
	);
	lines.push(
		`verified: ${totals.verified} | approved: ${totals.approved} | flagged: ${totals.flagged} | accepted: ${totals.accepted} | escalated: ${totals.escalated} | audited: ${totals.audited} | kept: ${totals.kept} | skipped: ${totals.skipped} | errors: ${totals.errors}`,
		"",
	);
	lines.push(generateReviewTableSection(results));

	return lines.join("\n");
}

/**
 * ファイルごとの検証結果テーブルを生成する（純関数・テスト可能）。
 * AI同期の合成レポート（ai-sync-result）からも再利用する。
 * unitResults が空のファイルはスキップし、mismatch/partial を先頭に並べる。
 */
export function generateReviewTableSection(results: AiReviewFileResult[]): string {
	const lines: string[] = [];
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
		case "accepted":
			return "🤝 accepted";
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
