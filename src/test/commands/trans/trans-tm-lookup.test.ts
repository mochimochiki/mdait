import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateHash } from "../../../core/hash/hash-calculator";
import { stripMarkdown } from "../../../core/tm/tm-text-normalizer";
import { TmxStore } from "../../../core/tm/tmx-store";

/**
 * trans-command の TM検索で使用される正規化ロジックのテスト
 *
 * lookupTmReferences 関数は VSCode ワークスペースに依存するため、
 * ここでは正規化とハッシュ計算の組み合わせのみをテストする。
 * E2E統合テストは test-gui で実施。
 *
 * @note normalize処理（stripMarkdown）は Store/Ranker に内部化された（260320_TM_normalize一元化）。
 * 呼び出し側（trans-command）は生テキストをそのまま渡すようになっており、
 * TmxStore.findCandidatesByTrigram と tm-ranker.rankTmEntries が内部で normalizeForTm を適用する。
 */
suite("trans-command TM検索の正規化ロジック", () => {
	let tmpDir: string;
	let tmxPath: string;

	setup(() => {
		// 一時ディレクトリとTMXファイルパスを準備
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-tm-test-"));
		tmxPath = path.join(tmpDir, "translations.tmx");
	});

	teardown(() => {
		// 一時ファイルをクリーンアップ
		if (fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("Markdown含むソースが正規化されて同じハッシュになる", () => {
		// TM登録時と検索時で同じ正規化処理が適用されることを確認
		const sourceWithMarkdown = "This is **bold** text here.";
		const normalizedSource = stripMarkdown(sourceWithMarkdown);

		assert.strictEqual(normalizedSource, "This is bold text here.");

		// ハッシュ計算（登録時と検索時で同じハッシュが生成される）
		const hash1 = calculateHash(normalizedSource, true);
		const hash2 = calculateHash(stripMarkdown(sourceWithMarkdown), true);

		assert.strictEqual(hash1, hash2, "正規化後のハッシュは同じになるべき");
	});

	test("異なるMarkdown記法でも同じハッシュでマッチング", () => {
		// 太字の記法違い: ** と __
		const source1 = "Important **message** here to you.";
		const source2 = "Important __message__ here to you.";

		const normalized1 = stripMarkdown(source1);
		const normalized2 = stripMarkdown(source2);

		// 正規化後は同じテキストになることを確認
		assert.strictEqual(normalized1, normalized2, "正規化後は同じテキストになるべき");
		assert.strictEqual(normalized1, "Important message here to you.");

		const hash1 = calculateHash(normalized1, true);
		const hash2 = calculateHash(normalized2, true);

		assert.strictEqual(hash1, hash2, "ハッシュは同じになるべき");
	});

	test("リンク記法を含むソースも正規化されて同じハッシュになる", () => {
		const sourceWithLink = "See [documentation](https://example.com) for more details here.";
		const normalizedSource = stripMarkdown(sourceWithLink);

		assert.strictEqual(normalizedSource, "See documentation for more details here.");

		const hash = calculateHash(normalizedSource, true);
		const hashFromOriginal = calculateHash(stripMarkdown(sourceWithLink), true);

		assert.strictEqual(hash, hashFromOriginal, "ハッシュは同じになるべき");
	});

	test("複数のMarkdown要素を含む複雑な文の正規化", () => {
		const complexSource = "This is **bold** and *italic* with [link](url) and `code` here.";
		const normalizedSource = stripMarkdown(complexSource);

		assert.strictEqual(normalizedSource, "This is bold and italic with link and `code` here.");

		const hash = calculateHash(normalizedSource, true);
		const hashFromOriginal = calculateHash(stripMarkdown(complexSource), true);

		assert.strictEqual(hash, hashFromOriginal, "ハッシュは同じになるべき");
	});

	test("先頭frontmatterは正規化とハッシュ計算から除外される", () => {
		const sourceWithFrontmatter = "---\ntitle: Sample\n---\n\nThis is `code` here.";
		const normalizedSource = stripMarkdown(sourceWithFrontmatter);

		assert.strictEqual(normalizedSource, "This is `code` here.");

		const hash = calculateHash(normalizedSource, true);
		const hashFromOriginal = calculateHash(stripMarkdown(sourceWithFrontmatter), true);

		assert.strictEqual(hash, hashFromOriginal, "frontmatter除外後のハッシュは同じになるべき");
	});

	test("TmxStoreでの登録・検索の統合テスト", () => {
		const store = new TmxStore();

		// Markdown含むソースを正規化して登録
		const sourceWithMarkdown = "This is **bold** text here to test.";
		const normalizedSource = stripMarkdown(sourceWithMarkdown);
		const hash = calculateHash(normalizedSource, true);

		store.addEntry({
			tuid: hash,
			primary: normalizedSource,
			variants: new Map([
				["en", { text: normalizedSource }],
				["ja", { text: "これは太字のテキストです。" }],
			]),
		});

		assert.strictEqual(store.getEntryCount(), 1);

		// 同じMarkdown記法で検索
		const result1 = store.lookupByHash(hash, "en", "ja");
		assert.ok(result1 !== undefined, "登録されたエントリーが見つかるべき");
		assert.strictEqual(result1.source, normalizedSource);
		assert.strictEqual(result1.target, "これは太字のテキストです。");

		// 異なるMarkdown記法（__）で検索
		const sourceWithDifferentMarkdown = "This is __bold__ text here to test.";
		const normalizedSource2 = stripMarkdown(sourceWithDifferentMarkdown);
		const hash2 = calculateHash(normalizedSource2, true);

		// 同じハッシュになるため、同じエントリーが見つかる
		assert.strictEqual(hash, hash2, "ハッシュは同じになるべき");

		const result2 = store.lookupByHash(hash2, "en", "ja");
		assert.ok(result2 !== undefined, "同じエントリーが見つかるべき");
		assert.strictEqual(result2.source, normalizedSource);
	});

	test("TmxStoreでのバッチ検索の動作確認", () => {
		const store = new TmxStore();

		// 複数のエントリーを登録
		const entries = [
			{ source: "This is **bold** text here.", target: "太字テキスト。" },
			{ source: "See [link](url) for details.", target: "リンク参照。" },
			{ source: "Code `snippet` included here.", target: "コード含む。" },
		];

		for (const entry of entries) {
			const normalized = stripMarkdown(entry.source);
			const hash = calculateHash(normalized, true);
			store.addEntry({
				tuid: hash,
				primary: normalized,
				variants: new Map([
					["en", { text: normalized }],
					["ja", { text: entry.target }],
				]),
			});
		}

		assert.strictEqual(store.getEntryCount(), 3);

		// バッチ検索（lookupTmReferences 内で使用される lookupBatch をエミュレート）
		const searchSources = [
			"This is **bold** text here.",
			"See [link](url) for details.",
			"Not registered sentence here.",
		];

		const hashes = searchSources.map((s) => calculateHash(stripMarkdown(s), true));
		const results = store.lookupBatch(hashes, "en", "ja");

		// 登録済みの2件がマッチする（3件目は未登録）
		assert.strictEqual(results.length, 2, "登録済みの2件がマッチするべき");
		assert.ok(results.some((r) => r.target === "太字テキスト。"));
		assert.ok(results.some((r) => r.target === "リンク参照。"));
	});
});
