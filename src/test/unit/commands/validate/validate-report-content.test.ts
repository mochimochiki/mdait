/**
 * @file validate-report-content.test.ts
 * @description 検証レポート生成（純粋関数）の単体テスト
 */
import * as assert from "node:assert";
import type { ValidationReport } from "../../../../commands/validate/validate-command";
import { generateValidateReportContent } from "../../../../commands/validate/validate-report-content";

function emptyReport(): ValidationReport {
	return {
		checks: ["structure", "terms"],
		filesChecked: 3,
		unitsChecked: 10,
		unitsSkipped: 2,
		violations: [],
	};
}

suite("validate-report-content（検証レポート生成）", () => {
	test("違反0件のとき集計と「違反なし」定型文を出力する", () => {
		const content = generateValidateReportContent(emptyReport());
		assert.ok(content.includes("# Validation Results"), "タイトルを含む");
		assert.ok(content.includes("Files checked: 3"), "ファイル数の集計を含む");
		assert.ok(content.includes("Units checked: 10"), "ユニット数の集計を含む");
		assert.ok(content.includes("(no violations)"), "違反なしの定型文を含む");
	});

	test("違反はファイルごとにまとめられ、種別・ユニットhash・行リンク用のパスを含む", () => {
		const report = emptyReport();
		report.violations = [
			{
				file: "docs/en/guide.md",
				unitHash: "a1b2c3d4",
				check: "terms",
				term: "unit",
				expected: "ユニット",
				severity: "warning",
				message: "expected translation not found",
			},
			{
				file: "docs/en/guide.md",
				unitHash: "e5f6a7b8",
				check: "structure",
				actual: "codeBlockCount",
				severity: "warning",
				message: "code block count mismatch",
			},
			{
				file: "docs/en/intro.md",
				unitHash: "0badcafe",
				check: "terms",
				severity: "warning",
				message: "another violation",
			},
		];
		const content = generateValidateReportContent(report);
		assert.ok(content.includes("## Violations (3)"), "違反件数の見出しを含む");
		assert.ok(content.includes("[docs/en/guide.md](/docs/en/guide.md)"), "ファイルへのリンクを含む");
		assert.ok(content.includes("`terms`") && content.includes("`structure`"), "検証種別を含む");
		assert.ok(content.includes("`a1b2c3d4`"), "ユニットhashを含む");
		// 同一ファイルの違反が1つの見出しにまとまる（見出しはファイル数ぶんだけ）
		assert.strictEqual(content.split("### ").length - 1, 2, "ファイル見出しは2つ");
	});

	test("ラベル注入で表示言語を差し替えられる（ADR-260719-01）", () => {
		const content = generateValidateReportContent(emptyReport(), {
			title: "検証結果",
			summary: "サマリ",
			filesChecked: "検証ファイル数",
			unitsChecked: "検証ユニット数",
			unitsSkipped: "スキップ（need残り）",
			violationsHeading: "違反",
			noViolations: "（違反なし）",
			unit: "ユニット",
		});
		assert.ok(content.includes("# 検証結果"), "注入したタイトルが使われる");
		assert.ok(content.includes("検証ファイル数: 3"), "注入したラベルが使われる");
		assert.ok(content.includes("（違反なし）"), "注入した定型文が使われる");
	});
});
