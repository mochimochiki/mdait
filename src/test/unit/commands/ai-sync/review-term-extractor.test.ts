import * as assert from "node:assert";
import { extractBidirectionalTerms } from "../../../../commands/ai-sync/review-term-extractor";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";

function makeEntry(
	ja: string,
	en: string,
	options: { jaVariants?: string[]; enVariants?: string[]; context?: string } = {},
): TermEntry {
	return TermEntry.create(options.context ?? "", {
		ja: LangTerm.create(ja, options.jaVariants ?? []),
		en: LangTerm.create(en, options.enVariants ?? []),
	});
}

suite("extractBidirectionalTerms（原文・訳文の双方向用語抽出）", () => {
	test("原文側だけにヒットしたエントリが抽出される（訳語不使用の疑い）", () => {
		const terms = [makeEntry("キャッシュ", "cache")];
		const result = extractBidirectionalTerms("キャッシュを削除する。", "Remove the temporary store.", terms, "ja", "en");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].term, "キャッシュ");
		assert.strictEqual(result[0].translation, "cache");
	});

	test("訳文側だけにヒットしたエントリも抽出される（別訳語の混入検知）", () => {
		const terms = [makeEntry("キャッシュ", "cache")];
		const result = extractBidirectionalTerms("一時保存領域を削除する。", "Remove the cache.", terms, "ja", "en");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].term, "キャッシュ");
	});

	test("両側にヒットしても1件だけ返る", () => {
		const terms = [makeEntry("キャッシュ", "cache")];
		const result = extractBidirectionalTerms("キャッシュを削除。", "Remove the cache.", terms, "ja", "en");
		assert.strictEqual(result.length, 1);
	});

	test("どちらにもヒットしないエントリは除外される", () => {
		const terms = [makeEntry("キャッシュ", "cache"), makeEntry("同期", "sync")];
		const result = extractBidirectionalTerms("キャッシュを削除。", "Remove the cache.", terms, "ja", "en");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].term, "キャッシュ");
	});

	test("variants（表記揺れ）でもヒットする", () => {
		const terms = [makeEntry("キャッシュ", "cache", { jaVariants: ["cache機構"], enVariants: ["caching"] })];
		const bySourceVariant = extractBidirectionalTerms("cache機構を使う。", "Use the store.", terms, "ja", "en");
		assert.strictEqual(bySourceVariant.length, 1);
		const byTargetVariant = extractBidirectionalTerms("仕組みを使う。", "Use caching here.", terms, "ja", "en");
		assert.strictEqual(byTargetVariant.length, 1);
	});

	test("片方の言語しか持たないエントリは対象外", () => {
		const jaOnly = TermEntry.create("", { ja: LangTerm.create("キャッシュ") });
		const result = extractBidirectionalTerms("キャッシュを削除。", "Remove the cache.", [jaOnly], "ja", "en");
		assert.strictEqual(result.length, 0);
	});

	test("コードブロック・インラインコード内の出現はヒットしない", () => {
		const terms = [makeEntry("キャッシュ", "cache")];
		const source = "設定を変更する。\n\n```\nキャッシュ\n```\n";
		const target = "Change the settings. Use `cache` wisely.";
		const result = extractBidirectionalTerms(source, target, terms, "ja", "en");
		assert.strictEqual(result.length, 0);
	});

	test("context が設定されていれば結果に含まれる", () => {
		const terms = [makeEntry("キャッシュ", "cache", { context: "storage layer" })];
		const result = extractBidirectionalTerms("キャッシュを削除。", "x", terms, "ja", "en");
		assert.strictEqual(result[0].context, "storage layer");
	});

	test("用語集が空なら空配列を返す", () => {
		assert.deepStrictEqual(extractBidirectionalTerms("キャッシュ。", "cache.", [], "ja", "en"), []);
	});
});
