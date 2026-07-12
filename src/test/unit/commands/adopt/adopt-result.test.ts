import * as assert from "node:assert";
import {
	type AdoptOutcome,
	buildAdoptNextActions,
	formatSyncLine,
	generateAdoptReportContent,
} from "../../../../commands/adopt/adopt-result";
import type { AiReviewFileResult, UnitReviewResult } from "../../../../commands/ai-review/review-result";
import type { SyncResult } from "../../../../commands/sync/sync-command";

function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		totalFileCount: 2,
		successCount: 2,
		errorCount: 0,
		totalAdded: 0,
		totalModified: 0,
		totalDeleted: 0,
		totalUnchanged: 0,
		revisionsNeeded: 0,
		totalAdopted: 0,
		totalKept: 0,
		totalOrphanReviewed: 0,
		totalAlignCorrections: 0,
		durationMs: 10,
		...overrides,
	};
}

function unit(action: UnitReviewResult["action"], verdict?: UnitReviewResult["verdict"], title = "Sec"): UnitReviewResult {
	return { filePath: "en/doc.md", unitHash: "h1", fromHash: "f1", title, issues: [], action, verdict, confidence: 0.9 };
}

function reviewFile(units: UnitReviewResult[]): AiReviewFileResult {
	return {
		filePath: "/ws/en/doc.md",
		verified: units.filter((u) => u.action !== "skipped").length,
		approved: units.filter((u) => u.action === "approved").length,
		escalated: units.filter((u) => u.action === "escalated").length,
		flagged: units.filter((u) => u.action === "flagged").length,
		audited: units.filter((u) => u.action === "audited").length,
		kept: units.filter((u) => u.action === "kept").length,
		skipped: units.filter((u) => u.action === "skipped").length,
		errors: units.filter((u) => u.action === "error").length,
		unitResults: units,
		markersChanged: false,
	};
}

function outcome(overrides: Partial<AdoptOutcome> = {}): AdoptOutcome {
	return { sync: syncResult(), review: [], stageErrors: [], dryRun: false, aborted: false, ...overrides };
}

suite("generateAdoptReportContent（統合レポート・純関数）", () => {
	test("sync 段のサマリとレビュー段のサマリを両方含む", () => {
		const report = generateAdoptReportContent(
			outcome({
				sync: syncResult({ totalAdopted: 3, totalAlignCorrections: 1 }),
				review: [reviewFile([unit("approved", "match"), unit("escalated", "mismatch")])],
			}),
		);
		assert.ok(report.includes("# mdait Adopt Existing Translations"));
		assert.ok(report.includes("## Sync (adopt + AI align)"));
		assert.ok(report.includes("adopted: 3"));
		assert.ok(report.includes("align-corrected: 1"));
		assert.ok(report.includes("## AI Translation Review"));
		assert.ok(report.includes("verified: 2"));
		assert.ok(report.includes("approved: 1"));
		assert.ok(report.includes("escalated: 1"));
		// レビュー表（ファイル別）も埋め込まれる
		assert.ok(report.includes("| action | verdict | confidence | unit | reason |"));
	});

	test("用語集・TM セクションは各段を実行したときだけ出る", () => {
		const without = generateAdoptReportContent(outcome());
		assert.ok(!without.includes("## Glossary"));
		assert.ok(!without.includes("## Translation Memory"));

		const withBoth = generateAdoptReportContent(
			outcome({
				term: { detected: 4, expanded: 2, remaining: 1 },
				tm: { files: 3, processedUnits: 10, newEntries: 8, existingEntries: 2, warnedEntries: 1, errorUnits: 0 },
			}),
		);
		assert.ok(withBoth.includes("## Glossary"));
		assert.ok(withBoth.includes("detected: 4 | expanded: 2 | remaining: 1"));
		assert.ok(withBoth.includes("## Translation Memory"));
		assert.ok(withBoth.includes("new: 8"));
	});

	test("stageErrors があればレポート末尾に列挙される", () => {
		const report = generateAdoptReportContent(
			outcome({
				stageErrors: [
					{ stage: "termDetect", scope: "ja -> en", message: "detect boom" },
					{ stage: "tmCommit", scope: "/ws/en/a.md", message: "tm boom" },
				],
			}),
		);
		assert.ok(report.includes("## Stage errors"));
		assert.ok(report.includes("termDetect (ja -> en): detect boom"));
		assert.ok(report.includes("tmCommit (/ws/en/a.md): tm boom"));
	});

	test("aborted のときは sync が走らなかった旨を出す", () => {
		const report = generateAdoptReportContent(outcome({ sync: undefined, aborted: true }));
		assert.ok(report.includes("Sync did not run"));
	});

	test("dryRun のときはマーカー不変＋用語集/TM スキップの注記を出す", () => {
		const report = generateAdoptReportContent(outcome({ dryRun: true, review: [reviewFile([unit("kept", "match")])] }));
		assert.ok(report.includes("dry run"));
		assert.ok(report.includes("glossary and TM steps were skipped"));
	});

	test("レビュー0件でもレポートは生成される（冪等 no-op）", () => {
		const report = generateAdoptReportContent(outcome());
		assert.ok(report.includes("verified: 0"));
	});
});

suite("buildAdoptNextActions（取り込み nextActions・純関数）", () => {
	test("aborted のときは設定確認を促す1件のみ", () => {
		const actions = buildAdoptNextActions(outcome({ sync: undefined, aborted: true }));
		assert.strictEqual(actions.length, 1);
		assert.ok(actions[0].includes("Sync did not run"));
		assert.ok(actions[0].includes("mdait_adopt"));
	});

	test("mismatch があれば構造修正→再取り込みを促す", () => {
		const actions = buildAdoptNextActions(outcome({ review: [reviewFile([unit("escalated", "mismatch")])] }));
		assert.ok(actions.some((a) => a.includes("mis-paired") && a.includes("mdait_adopt")));
	});

	test("TM 段未実行で approved があれば mdait_tm commit を促す", () => {
		const actions = buildAdoptNextActions(outcome({ review: [reviewFile([unit("approved", "match")])] }));
		assert.ok(actions.some((a) => a.includes("auto-approved") && a.includes('mdait_tm (action:"commit")')));
	});

	test("TM 段実行済みでエスカレーション残りがあれば「解消後に tm.commit 再実行」を案内する", () => {
		const actions = buildAdoptNextActions(
			outcome({
				review: [reviewFile([unit("escalated", "mismatch"), unit("approved", "match")])],
				tm: { files: 1, processedUnits: 1, newEntries: 1, existingEntries: 0, warnedEntries: 0, errorUnits: 0 },
			}),
		);
		assert.ok(actions.some((a) => a.includes("excluded from the TM") && a.includes('mdait_tm (action:"commit")')));
	});

	test("訳語未解決の用語が残っていれば用語補完の再実行を案内する", () => {
		const actions = buildAdoptNextActions(outcome({ term: { detected: 5, expanded: 3, remaining: 2 } }));
		assert.ok(actions.some((a) => a.includes("glossary term(s) still lack translations")));
	});

	test("dryRun かつ検証ありなら再実行を促す", () => {
		const actions = buildAdoptNextActions(outcome({ dryRun: true, review: [reviewFile([unit("kept", "match")])] }));
		assert.ok(actions.some((a) => a.includes("dry run") && a.includes("without dryRun")));
	});

	test("何も残っていなければ clean メッセージ（冪等 no-op）", () => {
		const actions = buildAdoptNextActions(outcome());
		assert.strictEqual(actions.length, 1);
		assert.ok(actions[0].includes("Adoption is clean"));
	});
});

suite("formatSyncLine（sync サマリ行・純関数）", () => {
	test("採用・アライン補正・追加・削除・保持・一次受けレビューを含む", () => {
		const line = formatSyncLine(syncResult({ totalAdopted: 5, totalAlignCorrections: 2, totalKept: 1, totalOrphanReviewed: 3 }));
		assert.ok(line.includes("adopted: 5"));
		assert.ok(line.includes("align-corrected: 2"));
		assert.ok(line.includes("kept: 1"));
		assert.ok(line.includes("orphan-reviewed: 3"));
	});
});
