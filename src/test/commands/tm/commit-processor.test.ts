import * as assert from "node:assert";
import { TmCommitProcessor, type TmCommitResolvedUnit } from "../../../commands/tm/commit-processor";
import type { LLMTmEntryGenerator, TmEntryGenerationRequest } from "../../../commands/tm/tm-entry-generator";
import { calculateHash } from "../../../core/hash/hash-calculator";
import { TmxStore } from "../../../core/tm/tmx-store";
import type { TmCommitEntry } from "../../../core/tm/types";

const PRIMARY_SENTENCE = "Primary sentence.";
const PRIMARY_TUID = calculateHash(PRIMARY_SENTENCE, true);

/**
 * テスト用LLMTmEntryGeneratorモック。
 * 事前に設定した固定のペアを返す。
 */
class MockLLMTmEntryGenerator {
	responses: TmCommitEntry[][] = [];
	requests: TmEntryGenerationRequest[] = [];

	async generateEntries(request: TmEntryGenerationRequest): Promise<TmCommitEntry[]> {
		this.requests.push(request);
		return this.responses.shift() ?? [];
	}
}

function createResolvedUnit(overrides?: Partial<TmCommitResolvedUnit>): TmCommitResolvedUnit {
	return {
		content: overrides?.content ?? "Primary sentence. Another sentence.",
		lang: overrides?.lang ?? "en",
		unitPath: overrides?.unitPath ?? "docs/guide.md",
		unitHash: overrides?.unitHash ?? "unit-primary-1",
	};
}

suite("TmCommitProcessor", () => {
	test("existing TM set と update必須tuid を期待通り導出できる", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			weight: 1,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE }],
				["ja", { text: "旧訳文" }],
			]),
		});
		store.addEntry({
			tuid: "b2c3d4e5",
			primary: "Another sentence.",
			weight: 1,
			variants: new Map([["en", { text: "Another sentence." }]]),
		});

		const generator = new MockLLMTmEntryGenerator();
		generator.responses = [[]];
		const processor = new TmCommitProcessor(store, generator as unknown as LLMTmEntryGenerator, "en", 0);
		await processor.processUnit(
			createResolvedUnit({ content: "Primary sentence. Another sentence." }),
			createResolvedUnit({
				content: "新しい訳文。 Another sentence.",
				lang: "ja",
				unitPath: "docs/guide.ja.md",
				unitHash: "new-local-hash",
			}),
		);

		assert.strictEqual(generator.requests.length, 1);
		const request = generator.requests[0];
		assert.deepStrictEqual(
			request.ExistingTmEntries.map((item) => item.tuid).sort(),
			["b2c3d4e5", PRIMARY_TUID].sort(),
		);
		assert.deepStrictEqual(request.requiredUpdateTuids.sort(), ["b2c3d4e5", PRIMARY_TUID].sort());
	});

	test("現在の local 文面が既に反映済みなら required update にしない", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			weight: 1,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE }],
				["ja", { text: "現在訳文" }],
			]),
		});

		const generator = new MockLLMTmEntryGenerator();
		generator.responses = [[]];
		const processor = new TmCommitProcessor(store, generator as unknown as LLMTmEntryGenerator, "en");

		await processor.processUnit(
			createResolvedUnit({ content: PRIMARY_SENTENCE }),
			createResolvedUnit({
				content: "現在訳文",
				lang: "ja",
				unitPath: "docs/guide.ja.md",
				unitHash: "new-local-hash",
			}),
		);

		assert.strictEqual(generator.requests.length, 1);
		assert.deepStrictEqual(generator.requests[0].requiredUpdateTuids, []);
	});

	test("guard が欠落・subset違反・文粒度違反を弾く", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			weight: 1,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE }],
				["ja", { text: "旧訳文" }],
			]),
		});
		const generator = new MockLLMTmEntryGenerator();
		generator.responses = [
			[
				{ type: "update", tuid: "zzzz9999", primary: "Primary sentence.", local: "更新訳" },
				{ type: "new", tuid: "-", primary: "Not included", local: "含まれない" },
				{ type: "new", tuid: "-", primary: "Primary sentence. Another sentence.", local: "複数文です。次です。" },
			],
		];

		const processor = new TmCommitProcessor(store, generator as unknown as LLMTmEntryGenerator, "en", 0);
		const result = await processor.processUnit(
			createResolvedUnit(),
			createResolvedUnit({
				content: "更新訳。別文。",
				lang: "ja",
				unitPath: "docs/guide.ja.md",
				unitHash: "new-local-hash",
			}),
		);

		assert.strictEqual(result.newCount, 0);
		assert.strictEqual(result.existingCount, 0);
		assert.strictEqual(result.warnedCount, 4);
		assert.ok(result.skippedCount >= 3);
	});

	test("focused retry が欠落分だけ再試行する", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			weight: 1,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE }],
				["ja", { text: "旧訳文" }],
			]),
		});
		const generator = new MockLLMTmEntryGenerator();
		generator.responses = [
			[],
			[{ type: "update", tuid: PRIMARY_TUID, primary: PRIMARY_SENTENCE, local: "更新済み訳文" }],
		];

		const processor = new TmCommitProcessor(store, generator as unknown as LLMTmEntryGenerator, "en", 1);
		const result = await processor.processUnit(
			createResolvedUnit({ content: "Primary sentence." }),
			createResolvedUnit({
				content: "更新済み訳文",
				lang: "ja",
				unitPath: "docs/guide.ja.md",
				unitHash: "new-local-hash",
			}),
		);

		assert.strictEqual(result.existingCount, 1);
		assert.strictEqual(generator.requests.length, 2);
		assert.deepStrictEqual(generator.requests[1].retryMissingTuids, [PRIMARY_TUID]);
	});

	test("retry 上限到達後も保存継続し warned に計上される", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			weight: 1,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE }],
				["ja", { text: "旧訳文" }],
			]),
		});
		const generator = new MockLLMTmEntryGenerator();
		generator.responses = [
			[{ type: "new", tuid: "-", primary: "Another sentence appears here.", local: "別文の新規訳がここにあります。" }],
			[],
		];

		const processor = new TmCommitProcessor(store, generator as unknown as LLMTmEntryGenerator, "en", 1);
		const result = await processor.processUnit(
			createResolvedUnit({ content: "Primary sentence. Another sentence appears here." }),
			createResolvedUnit({
				content: "更新不能。別文の新規訳がここにあります。",
				lang: "ja",
				unitPath: "docs/guide.ja.md",
				unitHash: "new-local-hash",
			}),
		);

		assert.strictEqual(result.newCount, 1);
		assert.strictEqual(result.warnedCount, 1);
		assert.strictEqual(store.findByTuid(PRIMARY_TUID)?.variants.get("ja")?.text, "旧訳文");
	});

	test("重複した new 候補でも件数集計は安定する", async () => {
		const store = new TmxStore();
		const generator = new MockLLMTmEntryGenerator();
		generator.responses = [
			[
				{ type: "new", tuid: "-", primary: "Another sentence appears here.", local: "別文の新規訳です。" },
				{ type: "new", tuid: "-", primary: "Another sentence appears here.", local: "別文の新規訳です。" },
			],
		];

		const processor = new TmCommitProcessor(store, generator as unknown as LLMTmEntryGenerator, "en", 0);
		const result = await processor.processUnit(
			createResolvedUnit({ content: "Primary sentence. Another sentence appears here." }),
			createResolvedUnit({
				content: "現在訳文。別文の新規訳です。",
				lang: "ja",
				unitPath: "docs/guide.ja.md",
				unitHash: "new-local-hash",
			}),
		);

		assert.strictEqual(result.newCount, 1);
		assert.strictEqual(result.existingCount, 0);
		assert.strictEqual(store.getEntryCount(), 1);
	});
});
