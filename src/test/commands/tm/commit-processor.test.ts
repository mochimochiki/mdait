import * as assert from "node:assert";
import { TmCommitProcessor, type TmCommitResolvedUnit } from "../../../commands/tm/commit-processor";
import type { SentenceAligner, SentenceAlignmentRequest } from "../../../commands/tm/sentence-aligner";
import { calculateHash } from "../../../core/hash/hash-calculator";
import { TmxStore } from "../../../core/tm/tmx-store";
import type { TmCommitPlanItem } from "../../../core/tm/types";

const PRIMARY_SENTENCE = "Primary sentence.";
const PRIMARY_TUID = calculateHash(PRIMARY_SENTENCE, true);

/**
 * テスト用SentenceAlignerモック。
 * 事前に設定した固定のペアを返す。
 */
class MockSentenceAligner {
	responses: TmCommitPlanItem[][] = [];
	requests: SentenceAlignmentRequest[] = [];

	async alignSentences(request: SentenceAlignmentRequest): Promise<TmCommitPlanItem[]> {
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
	test("existing TM set と update必須tuid を期待通り導出できる", () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE, unitPath: "docs/guide.md", unitHash: "unit-primary-1" }],
				["ja", { text: "旧訳文", unitPath: "docs/guide.ja.md", unitHash: "old-local-hash" }],
			]),
		});
		store.addEntry({
			tuid: "b2c3d4e5",
			primary: "Another sentence.",
			variants: new Map([["en", { text: "Another sentence.", unitPath: "docs/guide.md", unitHash: "unit-primary-1" }]]),
		});

		const processor = new TmCommitProcessor(store, new MockSentenceAligner() as unknown as SentenceAligner, "en");
		const existing = store.getExistingTmSet(
			"Primary sentence. Another sentence.",
			"en",
			"ja",
			"docs/guide.md",
			"unit-primary-1",
			"新しい訳文。",
			"docs/guide.ja.md",
			"new-local-hash",
		);
		assert.deepStrictEqual(
			existing.map((item) => item.tuid),
			[PRIMARY_TUID, "b2c3d4e5"],
		);

		const currentLocalText = "新しい訳文。 Another sentence.";
		const required = processor.deriveRequiredUpdateTuids(existing, "ja", "new-local-hash", currentLocalText);
		assert.deepStrictEqual(required, [PRIMARY_TUID, "b2c3d4e5"]);
	});

	test("現在の local 文面が既に反映済みなら required update にしない", () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE, unitPath: "docs/guide.md", unitHash: "unit-primary-1" }],
				["ja", { text: "現在訳文", unitPath: "docs/guide.ja.md", unitHash: "old-local-hash" }],
			]),
		});

		const processor = new TmCommitProcessor(store, new MockSentenceAligner() as unknown as SentenceAligner, "en");
		const existing = store.getExistingTmSet(
			"Primary sentence.",
			"en",
			"ja",
			"docs/guide.md",
			"unit-primary-1",
			"現在訳文",
			"docs/guide.ja.md",
			"new-local-hash",
		);

		const currentLocalText = "現在訳文";
		const required = processor.deriveRequiredUpdateTuids(existing, "ja", "new-local-hash", currentLocalText);
		assert.deepStrictEqual(required, []);
	});

	test("guard が欠落・subset違反・文粒度違反を弾く", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE, unitPath: "docs/guide.md", unitHash: "unit-primary-1" }],
				["ja", { text: "旧訳文", unitPath: "docs/guide.ja.md", unitHash: "old-local-hash" }],
			]),
		});
		const aligner = new MockSentenceAligner();
		aligner.responses = [
			[
				{ type: "update", tuid: "zzzz9999", primary: "Primary sentence.", local: "更新訳" },
				{ type: "new", tuid: "-", primary: "Not included", local: "含まれない" },
				{ type: "new", tuid: "-", primary: "Primary sentence. Another sentence.", local: "複数文です。次です。" },
			],
		];

		const processor = new TmCommitProcessor(store, aligner as unknown as SentenceAligner, "en", 0);
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
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE, unitPath: "docs/guide.md", unitHash: "unit-primary-1" }],
				["ja", { text: "旧訳文", unitPath: "docs/guide.ja.md", unitHash: "old-local-hash" }],
			]),
		});
		const aligner = new MockSentenceAligner();
		aligner.responses = [
			[],
			[{ type: "update", tuid: PRIMARY_TUID, primary: PRIMARY_SENTENCE, local: "更新済み訳文" }],
		];

		const processor = new TmCommitProcessor(store, aligner as unknown as SentenceAligner, "en", 1);
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
		assert.strictEqual(aligner.requests.length, 2);
		assert.deepStrictEqual(aligner.requests[1].retryMissingTuids, [PRIMARY_TUID]);
	});

	test("retry 上限到達後も保存継続し warned に計上される", async () => {
		const store = new TmxStore();
		store.addEntry({
			tuid: PRIMARY_TUID,
			primary: PRIMARY_SENTENCE,
			variants: new Map([
				["en", { text: PRIMARY_SENTENCE, unitPath: "docs/guide.md", unitHash: "unit-primary-1" }],
				["ja", { text: "旧訳文", unitPath: "docs/guide.ja.md", unitHash: "old-local-hash" }],
			]),
		});
		const aligner = new MockSentenceAligner();
		aligner.responses = [
			[{ type: "new", tuid: "-", primary: "Another sentence appears here.", local: "別文の新規訳がここにあります。" }],
			[],
		];

		const processor = new TmCommitProcessor(store, aligner as unknown as SentenceAligner, "en", 1);
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
		const aligner = new MockSentenceAligner();
		aligner.responses = [
			[
				{ type: "new", tuid: "-", primary: "Another sentence appears here.", local: "別文の新規訳です。" },
				{ type: "new", tuid: "-", primary: "Another sentence appears here.", local: "別文の新規訳です。" },
			],
		];

		const processor = new TmCommitProcessor(store, aligner as unknown as SentenceAligner, "en", 0);
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
