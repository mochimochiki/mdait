/**
 * @file term-detector.test.ts
 * @description AITermDetector の variants 検出・整形のテスト
 * fake AIService を注入し、AI応答からの variants パースを検証する。
 */

import { strict as assert } from "node:assert";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { AITermDetector } from "../../../../commands/term/term-detector";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { TermEntry } from "../../../../commands/term/term-entry";
import { UnitPair } from "../../../../commands/term/unit-pair";

/**
 * systemPrompt の種別に応じて定型JSONを返す fake AIService
 */
class FakeAIService implements AIService {
	constructor(
		private readonly pairsResponse: string,
		private readonly sourceOnlyResponse: string = "[]",
	) {}

	async sendMessage(systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		// PAIRSプロンプトは "translation pairs" を含む
		if (systemPrompt.includes("translation pairs")) {
			return this.pairsResponse;
		}
		return this.sourceOnlyResponse;
	}
}

suite("AITermDetector - variants検出", () => {
	// 対訳あり: target.marker.from === source.marker.hash かつ need フラグなし
	const sourceUnit = new MdaitUnit(new MdaitMarker("abc123"), "Section", 1, "# Section\n\nAPI endpoint content", 0, 2);
	const targetUnit = new MdaitUnit(
		new MdaitMarker("def456", "abc123"),
		"Section",
		1,
		"# Section\n\nAPIエンドポイントの内容",
		0,
		2,
	);

	test("対訳ペア検出でソース用語に variants が付与される", async () => {
		const response = JSON.stringify([
			{
				sourceTerm: "API endpoint",
				targetTerm: "APIエンドポイント",
				variants: ["api endpoint", "API end-point", "endpoints"],
				context: "API endpoint content",
			},
		]);
		const detector = new AITermDetector(new FakeAIService(response));
		const pair = UnitPair.create(sourceUnit, targetUnit);

		const terms = await detector.detectTerms([pair], "en", "ja", "en");

		assert.strictEqual(terms.length, 1);
		const entry = terms[0];
		assert.strictEqual(TermEntry.getTerm(entry, "en"), "API endpoint");
		assert.deepStrictEqual([...TermEntry.getvariants(entry, "en")], ["api endpoint", "API end-point", "endpoints"]);
	});

	test("target 用語には variants が付かない（ソース言語中心）", async () => {
		const response = JSON.stringify([
			{
				sourceTerm: "API endpoint",
				targetTerm: "APIエンドポイント",
				variants: ["api endpoint"],
				context: "API endpoint content",
			},
		]);
		const detector = new AITermDetector(new FakeAIService(response));
		const pair = UnitPair.create(sourceUnit, targetUnit);

		const terms = await detector.detectTerms([pair], "en", "ja", "en");

		assert.strictEqual(TermEntry.getTerm(terms[0], "ja"), "APIエンドポイント");
		assert.deepStrictEqual([...TermEntry.getvariants(terms[0], "ja")], []);
	});

	test("ソース単独検出で variants が付与される", async () => {
		const sourceOnly = JSON.stringify([
			{
				sourceTerm: "Markdown",
				variants: ["markdown", "Mark down"],
				context: "Markdown content",
			},
		]);
		const detector = new AITermDetector(new FakeAIService("[]", sourceOnly));
		// target なし → unpaired 経路
		const pair = UnitPair.create(sourceUnit, undefined);

		const terms = await detector.detectTerms([pair], "en", "ja", "en");

		assert.strictEqual(terms.length, 1);
		assert.strictEqual(TermEntry.getTerm(terms[0], "en"), "Markdown");
		assert.deepStrictEqual([...TermEntry.getvariants(terms[0], "en")], ["markdown", "Mark down"]);
		// ソース単独なので ja エントリは持たない
		assert.strictEqual(TermEntry.hasLanguage(terms[0], "ja"), false);
	});

	test("正規形と完全一致・重複・非文字列・空白の variants は除外される", async () => {
		const response = JSON.stringify([
			{
				sourceTerm: "API endpoint",
				targetTerm: "APIエンドポイント",
				// 正規形そのもの、完全一致の重複、数値、空白のみ、trim対象、大小差（保持）を含む
				variants: ["API endpoint", "endpoints", "endpoints", 123, "   ", "  Endpoints  "],
				context: "API endpoint content",
			},
		]);
		const detector = new AITermDetector(new FakeAIService(response));
		const pair = UnitPair.create(sourceUnit, targetUnit);

		const terms = await detector.detectTerms([pair], "en", "ja", "en");

		// "API endpoint" は正規形と一致 → 除外。"endpoints" は重複排除で1回。
		// "Endpoints" は大小のみ差だが照合が大小区別のため別variantとして保持。
		assert.deepStrictEqual([...TermEntry.getvariants(terms[0], "en")], ["endpoints", "Endpoints"]);
	});

	test("variants が配列でない・欠落している場合は空配列になる", async () => {
		const response = JSON.stringify([
			{ sourceTerm: "Endpoint", targetTerm: "エンドポイント", context: "Endpoint content" },
			{
				sourceTerm: "Payload",
				targetTerm: "ペイロード",
				variants: "not-an-array",
				context: "Payload content",
			},
		]);
		const detector = new AITermDetector(new FakeAIService(response));
		const pair = UnitPair.create(sourceUnit, targetUnit);

		const terms = await detector.detectTerms([pair], "en", "ja", "en");

		assert.strictEqual(terms.length, 2);
		assert.deepStrictEqual([...TermEntry.getvariants(terms[0], "en")], []);
		assert.deepStrictEqual([...TermEntry.getvariants(terms[1], "en")], []);
	});
});
