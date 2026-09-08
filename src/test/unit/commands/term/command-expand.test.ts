/**
 * @file command-expand.test.ts
 * @description extractFromBatches（用語展開のバッチ抽出）のエラー・キャンセル方針のテスト。
 * - 一部のバッチが失敗しても成功分の結果を保持する（最初の失敗で全体を中断しない）
 * - 全バッチ失敗時のみエラーを伝播する（0件展開の成功と誤認させない）
 * - キャンセルはバッチ失敗として扱わず、部分結果を持ち帰る
 */

import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import { extractFromBatches } from "../../../../commands/term/command-expand";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";
import type { TermExpander, TermExpansionContext } from "../../../../commands/term/term-expander";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { describeUnusableBatches } from "../../../../commands/shared/guidance";
import type { TransPair } from "../../../../infra/config/configuration";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

const transPair: TransPair = {
	sourceDir: "docs/en",
	targetDir: "docs/ja",
	sourceLang: "en",
	targetLang: "ja",
};

/**
 * バッチ分割閾値（8000文字）を跨ぐよう、大きな本文でコンテキストを作る。
 * 1コンテキスト約5000文字 × 2件 → 2バッチに分割される。
 */
function createLargeContext(termText: string): TermExpansionContext {
	const sourceUnit = new MdaitUnit(new MdaitMarker("abc123"), "Section", 1, "x".repeat(2500), 0, 2);
	const targetUnit = new MdaitUnit(new MdaitMarker("def456", "abc123"), "Section", 1, "y".repeat(2500), 0, 2);
	const term = TermEntry.create(`${termText} context`, {
		en: LangTerm.create(termText),
	});
	return { sourceUnit, targetUnit, terms: [term] };
}

/** バッチ呼び出しごとに指定のスクリプトを順に実行する TermExpander */
class ScriptedExpander implements TermExpander {
	public calls = 0;
	constructor(private readonly script: Array<() => Promise<Map<string, string>>>) {}

	async extractFromTranslationsBatch(): Promise<Map<string, string>> {
		const fn = this.script[this.calls++];
		return fn();
	}

	async translateTerms(): Promise<Map<string, string>> {
		return new Map();
	}
}

suite("extractFromBatches（用語展開のバッチ抽出）", () => {
	test("一部のバッチが失敗しても、成功したバッチの結果を保持して返すこと（全体を中断しない）", async () => {
		// バグ再現: 以前は最初の失敗バッチで全体を例外中断し、解決済みの結果まで破棄していた
		const expander = new ScriptedExpander([
			async () => {
				throw new Error("Language model is not available");
			},
			async () => new Map([["beta", "ベータ"]]),
		]);

		const { results } = await extractFromBatches(
			transPair,
			[createLargeContext("alpha"), createLargeContext("beta")],
			undefined,
			undefined,
			expander,
		);

		assert.equal(expander.calls, 2, "失敗後も残りのバッチが処理されること");
		assert.equal(results.size, 1);
		assert.equal(results.get("beta"), "ベータ", "成功したバッチの結果が保持されること");
	});

	test("全バッチが失敗した場合は成功扱いにせずエラーを伝播すること", async () => {
		const expander = new ScriptedExpander([
			async () => {
				throw new Error("Language model is not available");
			},
			async () => {
				throw new Error("Language model is not available");
			},
		]);

		await assert.rejects(
			extractFromBatches(
				transPair,
				[createLargeContext("alpha"), createLargeContext("beta")],
				undefined,
				undefined,
				expander,
			),
			/Language model is not available/,
		);
	});

	test("答えが使えなかったバッチは数えて返し、成功した分は残すこと", async () => {
		// 実測（意地悪シナリオ R7-N8）: 形の違う JSON しか受けていないのに
		// 「0 件展開しました」で終わり、答えが使えなかったことがどこにも出なかった
		const expander = new ScriptedExpander([
			async () => {
				throw new UnusableAIResponseError("invalid-format", "Term expansion response could not be read as JSON");
			},
			async () => new Map([["beta", "ベータ"]]),
		]);

		const result = await extractFromBatches(
			transPair,
			[createLargeContext("alpha"), createLargeContext("beta")],
			undefined,
			undefined,
			expander,
		);

		assert.equal(result.totalBatches, 2);
		assert.equal(result.unusableBatches, 1, "使えなかったバッチを数えていること");
		assert.equal(result.unusableReason, "invalid-format", "最初の理由を持ち帰っていること");
		assert.deepEqual([...result.results], [["beta", "ベータ"]], "成功した分は残すこと");
	});

	test("使えなかったバッチがあれば、通知に足す一文が組めること", () => {
		// 完了通知はこの一文を足して警告として出す（足さないと「0 件展開」としか読めない）
		const sentence = describeUnusableBatches({
			totalBatches: 2,
			unusableBatches: 1,
			unusableReason: "invalid-format",
		});
		assert.ok(sentence.length > 0, "一文が組めること");
		assert.equal(describeUnusableBatches({ totalBatches: 2, unusableBatches: 0 }), "", "使えた回だけなら足さないこと");
	});

	test("AI呼び出し中のキャンセル（CancellationError）はエラーにせず、解決済みの部分結果を返すこと", async () => {
		// バグ再現: キャンセルが失敗バッチとして数えられ、
		// "Error during term expansion: Canceled" のエラー通知が出ていた
		const expander = new ScriptedExpander([
			async () => new Map([["alpha", "アルファ"]]),
			async () => {
				throw new vscode.CancellationError();
			},
		]);

		const { results } = await extractFromBatches(
			transPair,
			[createLargeContext("alpha"), createLargeContext("beta")],
			undefined,
			undefined,
			expander,
		);

		assert.equal(results.size, 1, "キャンセル前に解決済みの結果が保持されること");
		assert.equal(results.get("alpha"), "アルファ");
	});

	test("トークンがキャンセル済みで素のエラーが投げられた場合もキャンセルとして扱うこと", async () => {
		const tokenSource = new vscode.CancellationTokenSource();
		const expander = new ScriptedExpander([
			async () => new Map([["alpha", "アルファ"]]),
			async () => {
				tokenSource.cancel();
				throw new Error("request aborted");
			},
		]);

		const { results } = await extractFromBatches(
			transPair,
			[createLargeContext("alpha"), createLargeContext("beta")],
			undefined,
			tokenSource.token,
			expander,
		);

		assert.equal(results.size, 1);
		assert.equal(results.get("alpha"), "アルファ");
	});
});
