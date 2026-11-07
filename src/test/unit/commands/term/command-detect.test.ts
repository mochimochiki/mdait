/**
 * @file command-detect.test.ts
 * @description detectTerm_CoreProc のエラー伝播と件数返却のテスト
 * AI呼び出しが失敗した場合に「0件検出の成功」と誤認させないことを検証する。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { detectTerm_CoreProc } from "../../../../commands/term/command-detect";
import { describeBatchFailures } from "../../../../commands/shared/guidance";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";
import type { TermDetector } from "../../../../commands/term/term-detector";
import { UnitPair } from "../../../../commands/term/unit-pair";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { Configuration, type TransPair } from "../../../../infra/config/configuration";
import { AiCallsStoppedError } from "../../../../infra/llm/ai-call-guard";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

declare let __vscodeMockWorkspaceRoot: string;

/** 常に失敗する用語検出サービス（AI未接続などを模擬） */
class FailingTermDetector implements TermDetector {
	async detectTerms(): Promise<readonly TermEntry[]> {
		throw new Error("Language model is not available. Please ensure GitHub Copilot is enabled.");
	}
}

/** 「AI は答えたが、その答えは使えない」を返す用語検出サービス */
class UnusableTermDetector implements TermDetector {
	async detectTerms(): Promise<readonly TermEntry[]> {
		throw new UnusableAIResponseError("invalid-format", "Term detection response was not usable: no JSON array found");
	}
}

/** 固定の用語を返す用語検出サービス */
class FixedTermDetector implements TermDetector {
	async detectTerms(): Promise<readonly TermEntry[]> {
		return [
			TermEntry.create("API endpoint context", {
				en: LangTerm.create("API endpoint"),
				ja: LangTerm.create("APIエンドポイント"),
			}),
		];
	}
}

function createPair(): UnitPair {
	const sourceUnit = new MdaitUnit(new MdaitMarker("abc123"), "Section", 1, "# Section\n\nAPI endpoint content", 0, 2);
	return UnitPair.create(sourceUnit, undefined);
}

/** バッチ分割の閾値（8000文字）を1つで超える大きなペア。並べた数だけバッチになる */
function createLargePair(): UnitPair {
	const sourceUnit = new MdaitUnit(new MdaitMarker("abc123"), "Section", 1, "x".repeat(5000), 0, 2);
	return UnitPair.create(sourceUnit, undefined);
}

/** 呼び出しごとに指定のスクリプトを順に実行する用語検出サービス */
class ScriptedTermDetector implements TermDetector {
	public calls = 0;
	constructor(private readonly script: Array<() => Promise<readonly TermEntry[]>>) {}

	async detectTerms(): Promise<readonly TermEntry[]> {
		return this.script[this.calls++]();
	}
}

const transPair: TransPair = {
	sourceDir: "docs/en",
	targetDir: "docs/ja",
	sourceLang: "en",
	targetLang: "ja",
};

const progressStub = { report: () => {} };

suite("detectTerm_CoreProc", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-term-detect-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("全バッチのAI呼び出しが失敗した場合は成功扱いにせずエラーを伝播する", async () => {
		await assert.rejects(
			detectTerm_CoreProc([createPair()], transPair, progressStub, undefined, new FailingTermDetector()),
			/Language model is not available/,
		);
	});

	test("用語が検出された場合は件数を返し用語集ファイルへ保存する", async () => {
		const result = await detectTerm_CoreProc(
			[createPair()],
			transPair,
			progressStub,
			undefined,
			new FixedTermDetector(),
		);

		assert.equal(result.entries.length, 1);
		assert.equal(TermEntry.getTerm(result.entries[0], "en"), "API endpoint");

		const termsPath = path.join(tempDir, ".mdait", "terms.csv");
		assert.ok(fs.existsSync(termsPath), "用語集ファイルが保存されていること");
		assert.ok(fs.readFileSync(termsPath, "utf8").includes("API endpoint"));
	});

	test("単一バッチのAI呼び出し中にキャンセルされた場合はエラーにせず途中結果を返す", async () => {
		// バグ再現: AI呼び出し中のキャンセルは CancellationError として表面化する。
		// これを失敗バッチとして数えると単一バッチ実行では「全バッチ失敗」になり、
		// 正常なキャンセルが "Term detection failed: Canceled" のエラー通知になっていた
		class CancellingTermDetector implements TermDetector {
			async detectTerms(): Promise<readonly TermEntry[]> {
				throw new vscode.CancellationError();
			}
		}

		const result = await detectTerm_CoreProc(
			[createPair()],
			transPair,
			progressStub,
			undefined,
			new CancellingTermDetector(),
		);

		assert.deepEqual(result.entries, [], "キャンセルは0件の正常終了として扱われること");
	});

	test("トークンがキャンセル済みで素のエラーが投げられた場合もキャンセルとして扱う", async () => {
		const tokenSource = new vscode.CancellationTokenSource();
		class AbortingTermDetector implements TermDetector {
			async detectTerms(): Promise<readonly TermEntry[]> {
				tokenSource.cancel();
				throw new Error("request aborted");
			}
		}

		const result = await detectTerm_CoreProc(
			[createPair()],
			transPair,
			progressStub,
			tokenSource.token,
			new AbortingTermDetector(),
		);

		assert.deepEqual(result.entries, [], "キャンセルとして途中結果が返り、エラーにならないこと");
	});

	test("用語が検出されなかった場合（AIは成功）は空配列を返しエラーにしない", async () => {
		class EmptyTermDetector implements TermDetector {
			async detectTerms(): Promise<readonly TermEntry[]> {
				return [];
			}
		}

		const result = await detectTerm_CoreProc(
			[createPair()],
			transPair,
			progressStub,
			undefined,
			new EmptyTermDetector(),
		);

		assert.equal(result.entries.length, 0);
		assert.equal(result.failedBatches, 0, "答えは使えたので、失敗した数は 0 であること");
		assert.equal(describeBatchFailures(result), "", "何も言い足さないこと");
	});

	test("答えが使えなかったバッチは「0件検出」に混ぜず、数えて返す", async () => {
		// 実測で見つかった欠陥の回帰固定: 壊れた答えを 0 件として飲み込んでいたため、
		// 利用者には「新しい用語 0 件」としか伝わらず、原稿のせいだと読める形で終わっていた
		// （意地悪シナリオ R6-N5 / N7 / N8）
		await assert.rejects(
			detectTerm_CoreProc([createPair()], transPair, progressStub, undefined, new UnusableTermDetector()),
			(error: unknown) => error instanceof UnusableAIResponseError,
			"全バッチが使えなかったときはエラーとして伝わること",
		);
	});

	test("使えなかったバッチがあれば、通知に足す一文が組める", () => {
		const sentence = describeBatchFailures({
			totalBatches: 3,
			failedBatches: 1,
			unusableBatches: 1,
			unusableReason: "invalid-format",
		});
		assert.ok(sentence.includes("1"), "使えなかった数が入っていること");
		assert.ok(sentence.includes("3"), "試した数が入っていること");
		assert.ok(sentence.length > 0);
	});

	test("答えが使えなかった以外の失敗も、成功したバッチがあるときに数えて返す", async () => {
		const detector = new ScriptedTermDetector([
			async () => new FixedTermDetector().detectTerms(),
			async () => {
				throw new Error("429 Too Many Requests");
			},
		]);

		const result = await detectTerm_CoreProc(
			[createLargePair(), createLargePair()],
			transPair,
			progressStub,
			undefined,
			detector,
		);

		assert.equal(result.entries.length, 1, "成功した分は残すこと");
		assert.equal(result.totalBatches, 2);
		assert.equal(result.failedBatches, 1, "失敗を理由を問わず数えること");
		assert.ok(describeBatchFailures(result).length > 0, "通知に足す一文が組めること");
	});

	test("歯止めが AI 呼び出しを止めたら、残りのバッチは投げずに打ち切る", async () => {
		const detector = new ScriptedTermDetector([
			async () => new FixedTermDetector().detectTerms(),
			async () => {
				throw new AiCallsStoppedError("stopped");
			},
			async () => [],
		]);

		const result = await detectTerm_CoreProc(
			[createLargePair(), createLargePair(), createLargePair()],
			transPair,
			progressStub,
			undefined,
			detector,
		);

		assert.equal(detector.calls, 2, "止まったあとのバッチを投げないこと");
		assert.equal(result.totalBatches, 2, "試したバッチだけを数えること");
		assert.equal(result.stoppedMessage, "stopped");
		assert.equal(result.entries.length, 1, "止まる前の結果は残すこと");
	});
});
