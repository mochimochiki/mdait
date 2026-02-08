import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SentenceAligner } from "../../../commands/tm-commit/sentence-aligner";
import { TmCommitProcessor } from "../../../commands/tm-commit/tm-commit-processor";
import { TmxStore } from "../../../core/tm/tmx-store";
import type { SentencePair } from "../../../core/tm/types";

/**
 * テスト用SentenceAlignerモック。
 * 事前に設定した固定のペアを返す。
 */
class MockSentenceAligner {
	/** alignSentences呼び出し回数 */
	callCount = 0;
	/** 返却するペア */
	pairs: SentencePair[] = [];

	async alignSentences(
		_sourceText: string,
		_targetText: string,
		_sourceLang: string,
		_targetLang: string,
		_cancellationToken?: unknown,
	): Promise<SentencePair[]> {
		this.callCount++;
		return this.pairs;
	}
}

/** テスト用一時ディレクトリとファイルパスを生成するヘルパー */
function createTempFilePath(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-proc-test-"));
	return path.join(tmpDir, "translations.tmx");
}

suite("TmCommitProcessor", () => {
	const unitPath = "docs/guide.md";

	suite("processUnit", () => {
		test("文ペアがTmxStoreに登録される", async () => {
			const tmxPath = createTempFilePath();
			const store = new TmxStore();

			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [
				{ source: "Hello world from here.", target: "こんにちは世界からこちら。" },
				{ source: "Good morning everyone.", target: "おはようございますみなさん。" },
			];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit(
				"Hello world from here. Good morning everyone.",
				"こんにちは世界からこちら。おはようございますみなさん。",
				unitPath,
			);

			assert.strictEqual(result.newCount, 2);
			assert.strictEqual(result.existingCount, 0);
			assert.strictEqual(result.skippedCount, 0);
			assert.strictEqual(mockAligner.callCount, 1);

			// ストアに登録されているか確認
			assert.strictEqual(store.getEntryCount(), 2);

			// ファイルに永続化できるか確認
			store.save(tmxPath);
			assert.ok(fs.existsSync(tmxPath));

			// 再読み込みして検証
			const reloaded = new TmxStore();
			reloaded.load(tmxPath);
			assert.strictEqual(reloaded.getEntryCount(), 2);

			// クリーンアップ
			fs.rmSync(path.dirname(tmxPath), { recursive: true });
		});

		test("アライメント結果が空の場合はスキップされる", async () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit("Some source text.", "翻訳テキスト。", unitPath);

			assert.strictEqual(result.newCount, 0);
			assert.strictEqual(result.existingCount, 0);
			assert.strictEqual(store.getEntryCount(), 0);
		});

		test("空文字ペアはスキップされる", async () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [
				{ source: "This is a valid sentence here.", target: "これは有効な文です。" },
				{ source: "", target: "空ソース文字列" },
				{ source: "空ターゲット文字列", target: "" },
			];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit("Source content", "ターゲットコンテンツ", unitPath);

			assert.strictEqual(result.newCount, 1);
			assert.strictEqual(result.skippedCount, 2);
			assert.strictEqual(store.getEntryCount(), 1);
		});

		test("Markdown含むペアは正規化されて登録される", async () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [
				{ source: "This is **bold** text here for testing.", target: "これは太字のテキストです。" },
				{ source: "See [link](url) for more info here.", target: "詳細はリンクを参照してください。" },
				{ source: "Code `snippet` removed from this sentence.", target: "コードは除去されます。" },
			];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit(
				"This is **bold** text here for testing. See [link](url) for more info here. Code `snippet` removed from this sentence.",
				"これは太字のテキストです。詳細はリンクを参照してください。コードは除去されます。",
				unitPath,
			);

			assert.strictEqual(result.newCount, 3);
			assert.strictEqual(result.skippedCount, 0);
			assert.strictEqual(store.getEntryCount(), 3);

			// ストア内のエントリーが正規化されていることを確認
			const entries = Array.from(store.entries.values());
			assert.ok(entries.some((e) => e.segments.get("en") === "This is bold text here for testing."));
			assert.ok(entries.some((e) => e.segments.get("en") === "See link for more info here."));
			assert.ok(entries.some((e) => e.segments.get("en") === "Code removed from this sentence."));
		});

		test("翻訳価値のない短文・断片はスキップされる", async () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [
				{ source: "This is a valid sentence here.", target: "有効な文です。" },
				{ source: "short", target: "短い" }, // 12文字未満
				{ source: "123", target: "123" }, // 数値のみ
				{ source: "Hello world", target: "こんにちは世界" }, // 2単語以下
				{ source: "https://example.com", target: "https://example.com" }, // URLのみ
			];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit(
				"This is a valid sentence here. short 123 Hello world https://example.com",
				"有効な文です。短い 123 こんにちは世界 https://example.com",
				unitPath,
			);

			assert.strictEqual(result.newCount, 1);
			assert.strictEqual(result.skippedCount, 4);
			assert.strictEqual(store.getEntryCount(), 1);

			// スキップされたペアがストアに存在しないことを確認
			const entries = Array.from(store.entries.values());
			assert.strictEqual(entries.length, 1);
			assert.strictEqual(entries[0].segments.get("en"), "This is a valid sentence here.");
		});
	});

	suite("registerPairs", () => {
		test("同一ハッシュの再登録は既存更新としてカウントされる", () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const pairs: SentencePair[] = [{ source: "This is the same sentence here.", target: "これは同じ文です。" }];

			// 初回登録
			const result1 = processor.registerPairs(pairs, unitPath);
			assert.strictEqual(result1.newCount, 1);
			assert.strictEqual(result1.existingCount, 0);

			// 同じ文ペアで再登録
			const unitPath2 = "docs/api.md";
			const result2 = processor.registerPairs(pairs, unitPath2);
			assert.strictEqual(result2.newCount, 0);
			assert.strictEqual(result2.existingCount, 1);

			// ストアには1エントリーのみ
			assert.strictEqual(store.getEntryCount(), 1);
		});
	});
});
