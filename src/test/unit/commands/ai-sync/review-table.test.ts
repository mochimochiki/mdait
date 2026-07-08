import * as assert from "node:assert";
import type { AiReviewFileResult, UnitReviewResult } from "../../../../commands/ai-sync/review-result";
import {
	buildReviewReport,
	generateReviewReportContent,
} from "../../../../commands/ai-sync/review-table";

function unit(action: UnitReviewResult["action"], unitHash: string, title: string): UnitReviewResult {
	return {
		filePath: "/ws/en/doc.md",
		unitHash,
		fromHash: "src000",
		title,
		verdict: action === "flagged" ? "partial" : "match",
		confidence: 0.8,
		issues: [],
		action,
	};
}

function fileResult(units: UnitReviewResult[]): AiReviewFileResult {
	return {
		filePath: "/ws/en/doc.md",
		verified: units.length,
		approved: units.filter((u) => u.action === "approved").length,
		escalated: 0,
		flagged: units.filter((u) => u.action === "flagged").length,
		audited: units.filter((u) => u.action === "audited").length,
		kept: 0,
		skipped: 0,
		errors: 0,
		unitResults: units,
		markersChanged: false,
	};
}

suite("buildReviewReport（レポート＋flagged アンカー）", () => {
	test("flagged ユニットのアンカーが該当行を指す", () => {
		const results = [fileResult([unit("flagged", "tgtA111", "Section A"), unit("audited", "tgtB222", "Section B")])];
		const { content, anchors } = buildReviewReport(results);

		assert.strictEqual(anchors.length, 1, "flagged は1件");
		const anchor = anchors[0];
		assert.strictEqual(anchor.unitHash, "tgtA111");
		assert.strictEqual(anchor.filePath, "/ws/en/doc.md");
		assert.strictEqual(anchor.title, "Section A");

		// anchor.line がそのユニットのテーブル行を指す（0始まり）
		const rowLine = content.split("\n")[anchor.line];
		assert.ok(rowLine.includes("flagged"), `行が flagged 行でない: ${rowLine}`);
		assert.ok(rowLine.includes("Section A"), `行にタイトルが無い: ${rowLine}`);
	});

	test("audited のみならアンカーは空", () => {
		const results = [fileResult([unit("audited", "tgtB222", "Section B")])];
		const { anchors } = buildReviewReport(results);
		assert.strictEqual(anchors.length, 0);
	});

	test("generateReviewReportContent は buildReviewReport().content と一致（後方互換）", () => {
		const results = [fileResult([unit("flagged", "tgtA111", "Section A")])];
		assert.strictEqual(generateReviewReportContent(results), buildReviewReport(results).content);
	});

	test("複数ファイルで各 flagged 行が正しく対応づく", () => {
		const a = fileResult([unit("flagged", "aaa111", "A")]);
		a.filePath = "/ws/en/a.md";
		a.unitResults = a.unitResults.map((u) => ({ ...u, filePath: "/ws/en/a.md" }));
		const b = fileResult([unit("audited", "bbb222", "B"), unit("flagged", "ccc333", "C")]);
		b.filePath = "/ws/en/b.md";
		b.unitResults = b.unitResults.map((u) => ({ ...u, filePath: "/ws/en/b.md" }));

		const { content, anchors } = buildReviewReport([a, b]);
		const lines = content.split("\n");
		assert.strictEqual(anchors.length, 2);
		for (const anchor of anchors) {
			assert.ok(lines[anchor.line].includes(anchor.title));
			assert.ok(lines[anchor.line].includes("flagged"));
		}
	});
});
