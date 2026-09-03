import * as assert from "node:assert";
import * as vscode from "vscode";
import { type AdoptStages, executeAdopt } from "../../../../commands/adopt/adopt-core";
import { createEmptyFileResult } from "../../../../commands/ai-review/review-result";
import type { SyncResult } from "../../../../commands/sync/sync-command";
import type { TermExpandResult } from "../../../../commands/term/command-expand";
import type { TermEntry } from "../../../../commands/term/term-entry";
import type { TmCommitResult } from "../../../../commands/tm/commit-processor";
import type { Configuration, TransPair } from "../../../../infra/config/configuration";

const NOOP_PROGRESS: vscode.Progress<{ message?: string; increment?: number }> = { report: () => {} };
const PAIR: TransPair = { sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" };
const CONFIG = { transPairs: [PAIR] } as Configuration;

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
		totalReviewsSuperseded: 0,
		totalKept: 0,
		totalOrphanReviewed: 0,
		totalOrphanDeletionWithheld: 0,
		totalOrphanRollbackWithheld: 0,
		totalAlignCorrections: 0,
		durationMs: 1,
		...overrides,
	};
}

function tmCommitResult(overrides: Partial<TmCommitResult> = {}): TmCommitResult {
	return {
		processedUnits: 2,
		skippedUnits: 0,
		newEntries: 1,
		existingEntries: 1,
		warnedEntries: 0,
		errorUnits: 0,
		newItems: [],
		updatedItems: [],
		...overrides,
	};
}

/** 呼び出しを記録するスタブ各段 */
class StubStages implements AdoptStages {
	public calls: string[] = [];
	public reviewedFiles: string[] | undefined;
	public reviewedDryRun: boolean | undefined;
	public afterReview: (() => void) | undefined;
	public termDetectError: Error | undefined;
	public termExpandError: Error | undefined;
	public tmCommitError: Error | undefined;
	constructor(
		private readonly sync: SyncResult | undefined,
		private readonly targets: string[],
		private readonly afterSync?: () => void,
		private readonly afterCollect?: () => void,
	) {}

	async runSync(): Promise<SyncResult | undefined> {
		this.calls.push("sync");
		this.afterSync?.();
		return this.sync;
	}
	async collectTargets(): Promise<string[]> {
		this.calls.push("collect");
		this.afterCollect?.();
		return this.targets;
	}
	async runReview(files: string[], _config: Configuration, options: { dryRun?: boolean }) {
		this.calls.push("review");
		this.reviewedFiles = files;
		this.reviewedDryRun = options.dryRun;
		this.afterReview?.();
		return files.map((f) => createEmptyFileResult(f));
	}
	async collectSourceFiles(pair: TransPair): Promise<string[]> {
		this.calls.push(`sources:${pair.sourceLang}`);
		return ["/ws/ja/a.md"];
	}
	async runTermDetect(pair: TransPair): Promise<TermEntry[]> {
		this.calls.push(`termDetect:${pair.sourceLang}->${pair.targetLang}`);
		if (this.termDetectError) {
			throw this.termDetectError;
		}
		return [{ languages: {} }, { languages: {} }] as TermEntry[];
	}
	async runTermExpand(pair: TransPair): Promise<TermExpandResult> {
		this.calls.push(`termExpand:${pair.sourceLang}->${pair.targetLang}`);
		if (this.termExpandError) {
			throw this.termExpandError;
		}
		return { expanded: 3, remaining: 1 };
	}
	async runTmCommit(targetFile: string): Promise<TmCommitResult> {
		this.calls.push(`tmCommit:${targetFile}`);
		if (this.tmCommitError) {
			throw this.tmCommitError;
		}
		return tmCommitResult();
	}
}

suite("executeAdopt（取り込みウィザードオーケストレーター）", () => {
	test("既定オプションでは sync → collect → review のみを呼び用語集・TM 段は呼ばない", async () => {
		const stages = new StubStages(syncResult({ totalAdopted: 2 }), ["/ws/en/a.md", "/ws/en/b.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, {}, NOOP_PROGRESS, token, stages);

		assert.deepStrictEqual(stages.calls, ["sync", "collect", "review"]);
		assert.strictEqual(outcome.aborted, false);
		assert.strictEqual(outcome.sync?.totalAdopted, 2);
		assert.strictEqual(outcome.review.length, 2);
		assert.strictEqual(outcome.term, undefined);
		assert.strictEqual(outcome.tm, undefined);
		assert.deepStrictEqual(stages.reviewedFiles, ["/ws/en/a.md", "/ws/en/b.md"]);
	});

	test("全段オプトイン時は sync → review → 用語検出 → 用語補完 → TM登録 の順で呼ばれ集計が返る", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md", "/ws/en/b.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { buildGlossary: true, buildTm: true }, NOOP_PROGRESS, token, stages);

		assert.deepStrictEqual(stages.calls, [
			"sync",
			"collect",
			"review",
			"sources:ja",
			"termDetect:ja->en",
			"termExpand:ja->en",
			"tmCommit:/ws/en/a.md",
			"tmCommit:/ws/en/b.md",
		]);
		assert.deepStrictEqual(outcome.term, { detected: 2, expanded: 3, remaining: 1 });
		assert.deepStrictEqual(outcome.tm, {
			files: 2,
			processedUnits: 4,
			newEntries: 2,
			existingEntries: 2,
			warnedEntries: 0,
			errorUnits: 0,
		});
		assert.deepStrictEqual(outcome.stageErrors, []);
	});

	test("buildGlossary のみ選択時は TM 段を呼ばない", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { buildGlossary: true }, NOOP_PROGRESS, token, stages);

		assert.ok(stages.calls.includes("termDetect:ja->en"));
		assert.ok(!stages.calls.some((c) => c.startsWith("tmCommit")));
		assert.strictEqual(outcome.tm, undefined);
	});

	test("dryRun ではオプトインしていても用語集・TM 段をスキップする（知識ストア非書き込み）", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(
			CONFIG,
			{ dryRun: true, buildGlossary: true, buildTm: true },
			NOOP_PROGRESS,
			token,
			stages,
		);

		assert.deepStrictEqual(stages.calls, ["sync", "collect", "review"]);
		assert.strictEqual(stages.reviewedDryRun, true);
		assert.strictEqual(outcome.dryRun, true);
		assert.strictEqual(outcome.term, undefined);
		assert.strictEqual(outcome.tm, undefined);
	});

	test("sync が undefined を返したら aborted で中断し後段を一切呼ばない（設定不正フォールバック）", async () => {
		const stages = new StubStages(undefined, ["/ws/en/a.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { buildGlossary: true, buildTm: true }, NOOP_PROGRESS, token, stages);

		assert.strictEqual(outcome.aborted, true);
		assert.strictEqual(outcome.sync, undefined);
		assert.deepStrictEqual(outcome.review, []);
		assert.deepStrictEqual(stages.calls, ["sync"]);
	});

	test("sync 後にキャンセル済みならレビュー段以降をスキップする", async () => {
		const cts = new vscode.CancellationTokenSource();
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"], () => cts.cancel());

		const outcome = await executeAdopt(CONFIG, { buildGlossary: true }, NOOP_PROGRESS, cts.token, stages);

		assert.strictEqual(outcome.aborted, false);
		assert.ok(outcome.sync);
		assert.deepStrictEqual(outcome.review, []);
		assert.deepStrictEqual(stages.calls, ["sync"]);
	});

	test("ターゲット列挙後にキャンセル済みならレビュー段を呼ばない（AIService の無駄な構築を回避）", async () => {
		const cts = new vscode.CancellationTokenSource();
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"], undefined, () => cts.cancel());

		const outcome = await executeAdopt(CONFIG, {}, NOOP_PROGRESS, cts.token, stages);

		assert.strictEqual(outcome.aborted, false);
		assert.ok(outcome.sync);
		assert.deepStrictEqual(outcome.review, []);
		assert.deepStrictEqual(stages.calls, ["sync", "collect"]);
	});

	test("レビュー後にキャンセル済みなら用語集・TM 段を呼ばず完了分の結果を返す", async () => {
		const cts = new vscode.CancellationTokenSource();
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"]);
		stages.afterReview = () => cts.cancel();

		const outcome = await executeAdopt(
			CONFIG,
			{ buildGlossary: true, buildTm: true },
			NOOP_PROGRESS,
			cts.token,
			stages,
		);

		assert.deepStrictEqual(stages.calls, ["sync", "collect", "review"]);
		assert.strictEqual(outcome.review.length, 1);
		assert.strictEqual(outcome.term, undefined);
		assert.strictEqual(outcome.tm, undefined);
	});

	test("用語検出の失敗は stageErrors に記録され、用語補完と TM 段は続行される", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"]);
		stages.termDetectError = new Error("detect boom");
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { buildGlossary: true, buildTm: true }, NOOP_PROGRESS, token, stages);

		assert.strictEqual(outcome.stageErrors.length, 1);
		assert.strictEqual(outcome.stageErrors[0].stage, "termDetect");
		assert.strictEqual(outcome.stageErrors[0].scope, "ja -> en");
		assert.ok(outcome.stageErrors[0].message.includes("detect boom"));
		assert.ok(stages.calls.includes("termExpand:ja->en"));
		assert.ok(stages.calls.includes("tmCommit:/ws/en/a.md"));
		assert.deepStrictEqual(outcome.term, { detected: 0, expanded: 3, remaining: 1 });
		assert.ok(outcome.tm);
	});

	test("TM 登録のファイル単位の失敗は stageErrors に記録され残りのファイルは続行される", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md", "/ws/en/b.md"]);
		let first = true;
		const original = stages.runTmCommit.bind(stages);
		stages.runTmCommit = async (file: string) => {
			if (first) {
				first = false;
				stages.calls.push(`tmCommit:${file}`);
				throw new Error("tm boom");
			}
			return original(file);
		};
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { buildTm: true }, NOOP_PROGRESS, token, stages);

		assert.strictEqual(outcome.stageErrors.length, 1);
		assert.strictEqual(outcome.stageErrors[0].stage, "tmCommit");
		assert.strictEqual(outcome.stageErrors[0].scope, "/ws/en/a.md");
		assert.strictEqual(outcome.tm?.files, 1);
	});

	test("対象ターゲットが0件ならレビュー・TM 段は実質 no-op で安全に完了する", async () => {
		const stages = new StubStages(syncResult(), []);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { buildTm: true }, NOOP_PROGRESS, token, stages);

		assert.deepStrictEqual(stages.calls, ["sync", "collect"]);
		assert.deepStrictEqual(outcome.review, []);
		assert.deepStrictEqual(outcome.tm, {
			files: 0,
			processedUnits: 0,
			newEntries: 0,
			existingEntries: 0,
			warnedEntries: 0,
			errorUnits: 0,
		});
	});

	test("dryRun がレビュー段へ伝播する", async () => {
		const stages = new StubStages(syncResult(), ["/ws/en/a.md"]);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, { dryRun: true }, NOOP_PROGRESS, token, stages);

		assert.strictEqual(stages.reviewedDryRun, true);
		assert.strictEqual(outcome.dryRun, true);
	});

	test("2回目の冪等 no-op: sync が全0・レビュー0件でも安全に完了する", async () => {
		const stages = new StubStages(syncResult(), []);
		const token = new vscode.CancellationTokenSource().token;

		const outcome = await executeAdopt(CONFIG, {}, NOOP_PROGRESS, token, stages);

		assert.strictEqual(outcome.aborted, false);
		assert.strictEqual(outcome.sync?.totalAdopted, 0);
		assert.strictEqual(outcome.sync?.totalAlignCorrections, 0);
		assert.strictEqual(outcome.review.length, 0);
	});
});
