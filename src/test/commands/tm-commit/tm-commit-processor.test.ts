import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SentenceAligner } from "../../../commands/tm-commit/sentence-aligner";
import { TmCommitProcessor } from "../../../commands/tm-commit/tm-commit-processor";
import { TmxStore } from "../../../core/tm/tmx-store";
import type { SentencePair, TmUsedIn } from "../../../core/tm/types";

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
	const unitInfo: TmUsedIn = {
		unitPath: "docs/guide.md",
		unitHash: "abc12345",
	};

	suite("processUnit", () => {
		test("文ペアがTmxStoreに登録される", async () => {
			const tmxPath = createTempFilePath();
			const store = new TmxStore();

			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [
				{ source: "Hello world.", target: "こんにちは世界。" },
				{ source: "Good morning.", target: "おはようございます。" },
			];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit(
				"Hello world. Good morning.",
				"こんにちは世界。おはようございます。",
				unitInfo,
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

			const result = await processor.processUnit("Some source text.", "翻訳テキスト。", unitInfo);

			assert.strictEqual(result.newCount, 0);
			assert.strictEqual(result.existingCount, 0);
			assert.strictEqual(store.getEntryCount(), 0);
		});

		test("空文字ペアはスキップされる", async () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();
			mockAligner.pairs = [
				{ source: "Valid sentence.", target: "有効な文。" },
				{ source: "", target: "空ソース" },
				{ source: "空ターゲット", target: "" },
			];

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const result = await processor.processUnit("Source content", "ターゲットコンテンツ", unitInfo);

			assert.strictEqual(result.newCount, 1);
			assert.strictEqual(result.skippedCount, 2);
			assert.strictEqual(store.getEntryCount(), 1);
		});
	});

	suite("registerPairs", () => {
		test("同一ハッシュの再登録は既存更新としてカウントされる", () => {
			const store = new TmxStore();
			const mockAligner = new MockSentenceAligner();

			const processor = new TmCommitProcessor(store, mockAligner as unknown as SentenceAligner, "en", "ja");

			const pairs: SentencePair[] = [{ source: "Same sentence.", target: "同じ文。" }];

			// 初回登録
			const result1 = processor.registerPairs(pairs, unitInfo);
			assert.strictEqual(result1.newCount, 1);
			assert.strictEqual(result1.existingCount, 0);

			// 同じ文ペアで再登録
			const unitInfo2: TmUsedIn = {
				unitPath: "docs/api.md",
				unitHash: "def67890",
			};
			const result2 = processor.registerPairs(pairs, unitInfo2);
			assert.strictEqual(result2.newCount, 0);
			assert.strictEqual(result2.existingCount, 1);

			// ストアには1エントリーのみ
			assert.strictEqual(store.getEntryCount(), 1);
		});
	});
});
