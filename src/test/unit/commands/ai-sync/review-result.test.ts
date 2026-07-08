import * as assert from "node:assert";
import {
	type AiReviewFileResult,
	type ParsedVerifyResponse,
	type UnitReviewResult,
	aggregateReviewResults,
	decideReviewAction,
	formatReviewReason,
} from "../../../../commands/ai-sync/review-result";

function response(overrides: Partial<ParsedVerifyResponse> = {}): ParsedVerifyResponse {
	return {
		verdict: "match",
		confidence: 0.95,
		issues: [],
		reason: "Faithful and complete translation.",
		...overrides,
	};
}

const defaultPolicy = { autoApprove: true, threshold: 0.9 };

suite("decideReviewAction（判定→アクションの純関数）", () => {
	test("match かつ閾値以上かつ autoApprove 有効なら approve", () => {
		assert.strictEqual(decideReviewAction(response(), defaultPolicy), "approve");
	});

	test("match でも confidence が閾値未満なら keep", () => {
		assert.strictEqual(decideReviewAction(response({ confidence: 0.7 }), defaultPolicy), "keep");
	});

	test("match でも autoApprove 無効なら keep", () => {
		assert.strictEqual(decideReviewAction(response(), { autoApprove: false, threshold: 0.9 }), "keep");
	});

	test("match でも issues がある場合は keep（三重条件）", () => {
		assert.strictEqual(
			decideReviewAction(response({ issues: ["terminology inconsistency"] }), defaultPolicy),
			"keep",
		);
	});

	test("mismatch は confidence にかかわらず escalate", () => {
		assert.strictEqual(decideReviewAction(response({ verdict: "mismatch", confidence: 0.99 }), defaultPolicy), "escalate");
	});

	test("partial は escalate", () => {
		assert.strictEqual(
			decideReviewAction(response({ verdict: "partial", issues: ["omission: last paragraph"] }), defaultPolicy),
			"escalate",
		);
	});

	test("uncertain は keep", () => {
		assert.strictEqual(decideReviewAction(response({ verdict: "uncertain", confidence: 0 }), defaultPolicy), "keep");
	});

	test("閾値ちょうどの confidence は approve（境界値）", () => {
		assert.strictEqual(decideReviewAction(response({ confidence: 0.9 }), defaultPolicy), "approve");
	});
});

suite("formatReviewReason（hover向け判定サマリ）", () => {
	test("verdict・confidence・reason を含む文字列を生成する", () => {
		const text = formatReviewReason(response({ verdict: "mismatch", confidence: 0.85, reason: "Different topics." }));
		assert.ok(text.includes("mismatch"));
		assert.ok(text.includes("0.85"));
		assert.ok(text.includes("Different topics."));
	});

	test("issues がある場合は末尾に列挙される", () => {
		const text = formatReviewReason(response({ issues: ["omission: intro", "extra: footer"] }));
		assert.ok(text.includes("omission: intro; extra: footer"));
	});
});

function unit(action: UnitReviewResult["action"], verdict?: UnitReviewResult["verdict"]): UnitReviewResult {
	return { filePath: "en/doc.md", unitHash: "h", fromHash: "f", issues: [], action, verdict };
}

function fileResult(units: UnitReviewResult[], overrides: Partial<AiReviewFileResult> = {}): AiReviewFileResult {
	const approved = units.filter((u) => u.action === "approved").length;
	const skipped = units.filter((u) => u.action === "skipped").length;
	const errors = units.filter((u) => u.action === "error").length;
	const verified = units.filter((u) => u.action !== "skipped").length;
	const flagged = units.filter((u) => u.action === "flagged").length;
	return {
		filePath: "en/doc.md",
		verified,
		approved,
		escalated: units.filter((u) => u.action === "escalated").length,
		flagged,
		audited: units.filter((u) => u.action === "audited").length,
		kept: units.filter((u) => u.action === "kept").length,
		skipped,
		errors,
		unitResults: units,
		markersChanged: approved > 0 || flagged > 0,
		...overrides,
	};
}

suite("aggregateReviewResults（複数ファイルの集計・純関数）", () => {
	test("mismatch/partial を escalated に、uncertain/閾値未満を kept に分類する", () => {
		const results = [
			fileResult([
				unit("approved", "match"),
				unit("escalated", "mismatch"),
				unit("escalated", "partial"),
				unit("kept", "uncertain"),
				unit("kept", "match"),
			]),
		];
		const agg = aggregateReviewResults(results);
		assert.strictEqual(agg.approved, 1);
		assert.strictEqual(agg.mismatch, 1);
		assert.strictEqual(agg.partial, 1);
		assert.strictEqual(agg.escalated, 2);
		assert.strictEqual(agg.uncertain, 1);
		assert.strictEqual(agg.keptBelowThreshold, 1);
		assert.strictEqual(agg.kept, 2);
	});

	test("複数ファイルを合算し unitResults を持つファイル数を数える", () => {
		const results = [
			fileResult([unit("approved", "match")]),
			fileResult([unit("skipped"), unit("error")]),
			fileResult([]),
		];
		const agg = aggregateReviewResults(results);
		assert.strictEqual(agg.filesWithUnits, 2);
		assert.strictEqual(agg.skipped, 1);
		assert.strictEqual(agg.errors, 1);
		assert.strictEqual(agg.verified, 2);
	});

	test("空入力は全カウント0（冪等な no-op の集計）", () => {
		const agg = aggregateReviewResults([]);
		assert.strictEqual(agg.filesWithUnits, 0);
		assert.strictEqual(agg.verified, 0);
		assert.strictEqual(agg.escalated, 0);
		assert.strictEqual(agg.kept, 0);
	});

	test("audit の flagged / audited を集計する", () => {
		const results = [
			fileResult([
				unit("flagged", "mismatch"),
				unit("flagged", "partial"),
				unit("audited", "match"),
				unit("approved", "match"),
			]),
		];
		const agg = aggregateReviewResults(results);
		assert.strictEqual(agg.flagged, 2);
		assert.strictEqual(agg.audited, 1);
		assert.strictEqual(agg.approved, 1);
		// flagged は escalated（need:review 維持）とは別集計で、mismatch/partial には積まれない
		assert.strictEqual(agg.escalated, 0);
	});
});
