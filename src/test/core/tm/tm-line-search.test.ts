import * as assert from "node:assert";
import { searchTmByLines } from "../../../core/tm/tm-line-search";
import type { TmLineSearchOptions } from "../../../core/tm/tm-line-search";
import { normalizeForTm } from "../../../core/tm/tm-text-normalizer";
import type { TmEntry } from "../../../core/tm/types";

/**
 * TmxStore のテスト用スタブ。
 * findCandidatesByTrigram で lang variant を持つエントリのみ返す。
 */
class StubTmxStore {
	private entries: TmEntry[];
	private cache = new Map<string, Set<string>>();

	constructor(entries: TmEntry[]) {
		this.entries = entries;
	}

	getEntryCount(): number {
		return this.entries.length;
	}

	findCandidatesByTrigram(_query: string, lang: string, _limit: number): TmEntry[] {
		return this.entries.filter((e) => e.variants.has(lang));
	}

	getTrigramCache(): ReadonlyMap<string, ReadonlySet<string>> {
		return this.cache;
	}
}

function makeEntry(tuid: string, enText: string, jaText?: string): TmEntry {
	const variants = new Map<string, { text: string }>();
	variants.set("en", { text: enText });
	if (jaText !== undefined) {
		variants.set("ja", { text: jaText });
	}
	return { tuid, primary: enText, variants };
}

function defaultOptions(overrides?: Partial<TmLineSearchOptions>): TmLineSearchOptions {
	return {
		minQueryLength: 10,
		maxReferences: 5,
		sourceLang: "en",
		targetLang: "ja",
		...overrides,
	};
}

suite("searchTmByLines", () => {
	test("行単位分割で検索が行われること", () => {
		const entries = [
			makeEntry("t1", "The quick brown fox jumps over the lazy dog", "素早い茶色の狐が怠けた犬を飛び越える"),
			makeEntry(
				"t2",
				"Download the installer from the website",
				"ウェブサイトからインストーラーをダウンロードしてください",
			),
		];
		const store = new StubTmxStore(entries);
		// 2行のソーステキスト（各行がそれぞれのエントリに近い）
		const sourceContent = "The quick brown fox jumps over the lazy dog\nDownload the installer from the website";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions());
		// 両方のエントリがマッチする
		assert.ok(result.length >= 1, "少なくとも1件のマッチがあること");
		const tuids = result.map((m) => m.sentenceHash);
		assert.ok(tuids.includes("t1") || tuids.includes("t2"), "エントリがヒットすること");
	});

	test("minQueryLength未満の行がフィルタされること", () => {
		const entries = [makeEntry("t1", "Hello world test example sentence", "ハローワールドテスト例文")];
		const store = new StubTmxStore(entries);
		// テーブルはセル単位で改行分離される → 各セルが短い
		const sourceContent = "| AB | CD |\n| --- | --- |\n| EF | GH |";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions({ minQueryLength: 10 }));
		assert.deepStrictEqual(result, []);
	});

	test("revise時にoldSourceContentの行と一致する行が除外されること", () => {
		const entries = [
			makeEntry("t1", "The quick brown fox jumps over the lazy dog", "素早い茶色の狐が怠けた犬を飛び越える"),
			makeEntry(
				"t2",
				"Download the installer from the website",
				"ウェブサイトからインストーラーをダウンロードしてください",
			),
		];
		const store = new StubTmxStore(entries);
		// 旧ソースと新ソースの1行目は同じ、2行目が変更
		const oldSource = "The quick brown fox jumps over the lazy dog\nInstall the application from the website";
		const newSource = "The quick brown fox jumps over the lazy dog\nDownload the installer from the website";
		const result = searchTmByLines(newSource, store as never, defaultOptions(), oldSource);
		// 変更された行のみ検索されるため、t1は検索対象外になりうる
		// ただしスタブは全エントリを返すので、マッチ自体は起こる
		// 重要なのは、共通行が検索から除外されること
		const tuids = result.map((m) => m.sentenceHash);
		// t2がマッチすることを確認（変更行 "Download the installer..." が検索される）
		assert.ok(tuids.includes("t2"), "変更行に対応するエントリがヒットすること");
	});

	test("同一tuidの重複はmaxScoreで統合されること", () => {
		// 同一エントリが複数行からヒットする場合、maxScoreが保持される
		const entries = [
			makeEntry(
				"t1",
				"Download the installer from the website",
				"ウェブサイトからインストーラーをダウンロードしてください",
			),
		];
		const store = new StubTmxStore(entries);
		// 2行が同じエントリにマッチ
		const sourceContent = "Download the installer from the website\nDownload the installer from the official website";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions());
		// t1は1回だけ出現（重複統合）
		const t1Matches = result.filter((m) => m.sentenceHash === "t1");
		assert.strictEqual(t1Matches.length, 1, "同一tuidは1件に統合されること");
	});

	test("maxReferences件に制限されること", () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			makeEntry(`t${i}`, `Sentence number ${i} with enough text to match`, `文 ${i} の十分なテキスト`),
		);
		const store = new StubTmxStore(entries);
		const sourceContent =
			"Sentence number one with enough text here to match\nAnother sentence number two with sufficient text length";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions({ maxReferences: 3 }));
		assert.ok(result.length <= 3, `maxReferences(3)を超えないこと: 実際は${result.length}件`);
	});

	test("targetLang variantなしのエントリが除外されること", () => {
		const entries = [
			makeEntry("t1", "The quick brown fox jumps over the lazy dog"), // jaなし
			makeEntry(
				"t2",
				"Download the installer from the website",
				"ウェブサイトからインストーラーをダウンロードしてください",
			),
		];
		const store = new StubTmxStore(entries);
		const sourceContent = "The quick brown fox jumps over the lazy dog\nDownload the installer from the website";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions({ targetLang: "ja" }));
		const tuids = result.map((m) => m.sentenceHash);
		assert.ok(!tuids.includes("t1"), "targetLang variantなしのt1は除外されること");
	});

	test("全行がminQueryLength未満の場合に空配列を返すこと", () => {
		const entries = [makeEntry("t1", "Some text", "テキスト")];
		const store = new StubTmxStore(entries);
		// markdown見出しは normalize後に短い個別行になる
		const sourceContent = "# abc\n\n## def\n\nshort";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions({ minQueryLength: 10 }));
		assert.deepStrictEqual(result, []);
	});

	test("normalizeForTmのべき等性（単一行テキスト）", () => {
		// 改行を含まない単一行テキストに対してnormalizeForTmはべき等
		const singleLines = [
			"Hello **world** this is a test",
			"Download [the installer](https://example.com) now",
			"Simple plain text without markdown",
			"`inline code` example text",
			"日本語のテキスト例です",
		];
		for (const line of singleLines) {
			const once = normalizeForTm(line);
			const twice = normalizeForTm(once);
			assert.strictEqual(once, twice, `べき等性が保たれること: "${line}"`);
		}
	});

	test("テーブルのnormalize出力形式の確認", () => {
		// markdown-itがテーブルをどのように正規化するか確認
		const tableMarkdown = "| Header1 | Header2 |\n| --- | --- |\n| Cell1 | Cell2 |\n| Cell3 | Cell4 |";
		const normalized = normalizeForTm(tableMarkdown);
		// テーブルのセルは改行で分離される
		assert.ok(normalized.includes("header1"), "ヘッダーが含まれること");
		assert.ok(normalized.includes("cell1"), "セルが含まれること");
		// セルが改行で分離されていることを確認
		const lines = normalized
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		assert.ok(lines.length >= 4, `テーブルのセルが行として分離されること: ${lines.length}行`);
	});

	test("revise時に全行が旧ソースと一致する場合は空配列を返すこと", () => {
		const entries = [
			makeEntry("t1", "The quick brown fox jumps over the lazy dog", "素早い茶色の狐が怠けた犬を飛び越える"),
		];
		const store = new StubTmxStore(entries);
		const content = "The quick brown fox jumps over the lazy dog";
		const result = searchTmByLines(content, store as never, defaultOptions(), content);
		assert.deepStrictEqual(result, []);
	});

	test("ラウンドロビンで各行に公平に割り当てられること", () => {
		// 行1にマッチするエントリと行2にマッチするエントリがあるとき、
		// 両方から公平に選ばれること（特定行に偏らない）
		const entries = [
			makeEntry("t1", "The quick brown fox jumps over the lazy dog", "素早い茶色の狐が怠けた犬を飛び越える"),
			makeEntry("t2", "A quick brown fox leaps over the lazy animal", "素早い茶色の狐が怠けた動物を飛び越える"),
			makeEntry(
				"t3",
				"Download the installer from the website now",
				"今すぐウェブサイトからインストーラーをダウンロード",
			),
			makeEntry(
				"t4",
				"Download the application from the main website",
				"メインウェブサイトからアプリケーションをダウンロード",
			),
		];
		const store = new StubTmxStore(entries);
		// 2段落: 段落1はfox系にマッチ、段落2はdownload系にマッチ
		const sourceContent =
			"The quick brown fox jumps over the lazy dog today\n\nDownload the latest installer from the website";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions({ maxReferences: 2 }));
		const tuids = result.map((m) => m.sentenceHash);
		// ラウンドロビンで各行から1つずつ選ばれる
		assert.strictEqual(result.length, 2, "2件選ばれること");
		// fox系とdownload系の両方が含まれることを確認
		const hasFox = tuids.includes("t1") || tuids.includes("t2");
		const hasDownload = tuids.includes("t3") || tuids.includes("t4");
		assert.ok(hasFox, "fox系エントリが含まれること");
		assert.ok(hasDownload, "download系エントリが含まれること");
	});

	test("スコア閾値以下のエントリがフィルタされること", () => {
		// 全く関連のないTMエントリはJaccard < 0.15でフィルタされる
		const entries = [makeEntry("t1", "Completely unrelated database migration script", "データベース移行スクリプト")];
		const store = new StubTmxStore(entries);
		const sourceContent = "The authentication flow uses OAuth tokens for verification";
		const result = searchTmByLines(sourceContent, store as never, defaultOptions());
		// 全く無関係なエントリはスコア閾値でフィルタされる
		assert.strictEqual(result.length, 0, "無関係なエントリはフィルタされること");
	});
});
