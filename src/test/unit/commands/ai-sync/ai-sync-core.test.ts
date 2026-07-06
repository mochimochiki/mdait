import * as assert from "node:assert";
import * as vscode from "vscode";
import { type AiSyncStages, executeAiSync } from "../../../../commands/ai-sync/ai-sync-core";
import { createEmptyFileResult } from "../../../../commands/ai-sync/review-result";
import type { Configuration } from "../../../../infra/config/configuration";
import type { SyncResult } from "../../../../commands/sync/sync-command";

const NOOP_PROGRESS: vscode.Progress<{ message?: string; increment?: number }> = { report: () => {} };
const CONFIG = {} as Configuration;

function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		totalFileCount: 1,
		successCount: 1,
		errorCount: 0,
		totalAdded: 0,
		totalModified: 0,
		totalDeleted: 0,
		totalUnchanged: 0,
		revisionsNeeded: 0,
		totalAdopted: 0,
		totalKept: 0,
		totalBackfilled: 0,
		totalAlignCorrections: 0,
		durationMs: 1,
		...overrides,
	};
}

/** 呼び出しを記録するスタブ各段 */
class StubStages implements AiSyncStages {
	public calls: string[] = [];
	public reviewedFiles: string[] | undefined;
	public reviewedDryRun: boolean | undefined;
	constructor(
		private readonly sync: SyncResult | undefined,
		private readonly targets: string[],
		private readonly afterSync?: () => void,
	) {}

	async runSync(): Promise<SyncResult | undefined> {
		this.calls.push("sync");
		this.afterSync?.();
		return this.sync;
	}
	async collectTargets(): Promise<string[]> {
		this.calls.push("collect");
		return this.targets;
	}
	async runReview(files: string[], _config: Configuration, options: { dryRun?: boolean }) {
		this.calls.push("review");
		this.reviewedFiles = files;
		this.reviewedDryRun = options.dryRun;
		return files.map((f) => createEmptyFileResult(f));
	}
}

suite("executeAiSync（合成オーケストレーター）", () => {
	test("sync → collect → review の順に各段を呼び両結果を返す", async () => {
		const stages = new StubStages(syncResult({ totalAdopted: 2 }), ["/ws/en/a.md", "/ws/en/b.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAiSync(CONFIG, {}, NOOP_PROGRESS, token, stages);

		assert.deepStrictEqual(stages.calls, ["sync", "collect", "review"]);
		assert.strictEqual(outcome.aborted, false);
		assert.strictEqual(outcome.sync?.totalAdopted, 2);
		assert.strictEqual(outcome.review.length, 2);
		assert.deepStrictEqual(stages.reviewedFiles, ["/ws/en/a.md", "/ws/en/b.md"]);
	});

	test("sync が undefined を返したら aborted で中断しレビュー段を呼ばない（設定不正フォールバック）", async () => {
		const stages = new StubStages(undefined, ["/ws/en/a.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAiSync(CONFIG, {}, NOOP_PROGRESS, token, stages);

		assert.strictEqual(outcome.aborted, true);
		assert.strictEqual(outcome.sync, undefined);
		assert.deepStrictEqual(outcome.review, []);
		assert.deepStrictEqual(stages.calls, ["sync"]);
	});

	test("sync 後にキャンセル済みならレビュー段をスキップする", async () => {
		const cts = new vscode.CancellationTokenSource();
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"], () => cts.cancel());

		const outcome = await executeAiSync(CONFIG, {}, NOOP_PROGRESS, cts.token, stages);

		assert.strictEqual(outcome.aborted, false);
		assert.ok(outcome.sync);
		assert.deepStrictEqual(outcome.review, []);
		assert.deepStrictEqual(stages.calls, ["sync"]);
	});

	test("対象ターゲットが0件ならレビュー段を呼ばず空結果（no-op）", async () => {
		const stages = new StubStages(syncResult(), []);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAiSync(CONFIG, {}, NOOP_PROGRESS, token, stages);

		assert.deepStrictEqual(stages.calls, ["sync", "collect"]);
		assert.deepStrictEqual(outcome.review, []);
	});

	test("dryRun がレビュー段へ伝播する", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAiSync(CONFIG, { dryRun: true }, NOOP_PROGRESS, token, stages);

		assert.strictEqual(stages.reviewedDryRun, true);
		assert.strictEqual(outcome.dryRun, true);
	});

	test("2回目の冪等 no-op: sync が全0・レビュー0件でも安全に完了する", async () => {
		const stages = new StubStages(syncResult(), []);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAiSync(CONFIG, {}, NOOP_PROGRESS, token, stages);

		assert.strictEqual(outcome.aborted, false);
		assert.strictEqual(outcome.sync?.totalAdopted, 0);
		assert.strictEqual(outcome.sync?.totalAlignCorrections, 0);
		assert.strictEqual(outcome.review.length, 0);
	});
});
