import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeAdoptReport } from "../../../../commands/adopt/adopt-report-file";
import type { AdoptOutcome } from "../../../../commands/adopt/adopt-result";
import type { AiReviewFileResult, UnitReviewResult } from "../../../../commands/ai-review/review-result";
import type { SyncResult } from "../../../../commands/sync/sync-command";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

function syncResult(): SyncResult {
	return {
		totalFileCount: 1,
		successCount: 1,
		errorCount: 0,
		totalAdded: 0,
		totalModified: 0,
		totalDeleted: 0,
		totalUnchanged: 0,
		revisionsNeeded: 0,
		totalAdopted: 1,
		totalKept: 0,
		totalOrphanReviewed: 0,
		totalAlignCorrections: 0,
		durationMs: 1,
	};
}

function reviewFile(workspaceRoot: string, unit: UnitReviewResult): AiReviewFileResult {
	return {
		filePath: path.join(workspaceRoot, "en", "doc.md"),
		verified: 1,
		approved: 0,
		escalated: 1,
		flagged: 0,
		audited: 0,
		kept: 0,
		skipped: 0,
		errors: 0,
		unitResults: [unit],
		markersChanged: false,
	};
}

suite("writeAdoptReport（統合レポートの実ファイル書き出し）", () => {
	let tempDir: string;

	/** ワークスペースに mdait.json を作り Configuration を初期化する */
	async function initConfig(): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(configPath);
	}

	function outcome(review: AiReviewFileResult[] = []): AdoptOutcome {
		return { sync: syncResult(), review, stageErrors: [], dryRun: false, aborted: false };
	}

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-adopt-report-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("レポートは .mdait/adopt-report.md に書き出される", async () => {
		const config = await initConfig();
		const uri = await writeAdoptReport(config, outcome());

		assert.ok(uri, "URI が返る");
		assert.strictEqual(uri?.fsPath, path.join(tempDir, ".mdait", "adopt-report.md"));
		assert.strictEqual(uri?.fsPath, config.getAdoptReportFilePath());
		assert.ok(fs.existsSync(config.getAdoptReportFilePath()), "ファイルが存在する");
	});

	test("ユニット行はレポート位置（.mdait/）からの相対リンクになる", async () => {
		const config = await initConfig();
		const unit: UnitReviewResult = {
			filePath: path.join(tempDir, "en", "doc.md"),
			unitHash: "tgtA",
			fromHash: "srcA",
			title: "Section A",
			line: 12,
			issues: [],
			action: "escalated",
			verdict: "mismatch",
			confidence: 0.9,
		};
		await writeAdoptReport(config, outcome([reviewFile(tempDir, unit)]));

		const content = fs.readFileSync(config.getAdoptReportFilePath(), "utf-8");
		assert.ok(content.includes("[Section A](<../en/doc.md#L12>)"), content);
	});

	test("再実行すると上書きされる（履歴は git に委ねる）", async () => {
		const config = await initConfig();
		await writeAdoptReport(config, outcome());
		const first = fs.readFileSync(config.getAdoptReportFilePath(), "utf-8");

		const unit: UnitReviewResult = {
			filePath: path.join(tempDir, "en", "doc.md"),
			unitHash: "tgtA",
			fromHash: "srcA",
			title: "Section A",
			line: 3,
			issues: [],
			action: "approved",
			verdict: "match",
			confidence: 0.99,
		};
		await writeAdoptReport(config, outcome([reviewFile(tempDir, unit)]));
		const second = fs.readFileSync(config.getAdoptReportFilePath(), "utf-8");

		assert.notStrictEqual(first, second);
		assert.ok(second.includes("Section A"));
	});
});
