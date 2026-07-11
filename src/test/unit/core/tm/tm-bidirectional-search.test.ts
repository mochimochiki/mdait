import * as assert from "node:assert";
import { searchTmBidirectional } from "../../../../core/tm/tm-line-search";
import type { TmLineSearchOptions } from "../../../../core/tm/tm-line-search";
import type { TmEntry } from "../../../../core/tm/types";

/**
 * TmxStore のテスト用スタブ（tm-line-search.test.ts と同型）。
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

function makeEntry(tuid: string, enText?: string, jaText?: string): TmEntry {
	const variants = new Map<string, { text: string }>();
	if (enText !== undefined) {
		variants.set("en", { text: enText });
	}
	if (jaText !== undefined) {
		variants.set("ja", { text: jaText });
	}
	return { tuid, primary: enText ?? jaText ?? "", weight: 1, variants };
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

suite("searchTmBidirectional（原文・訳文の双方向TM検索）", () => {
	test("原文側ヒットと訳文側ヒットの両方が統合されて返る", () => {
		const entries = [
			// forward: 原文 "The quick brown fox..." にヒット
			makeEntry("fwd", "The quick brown fox jumps over the lazy dog", "素早い茶色の狐が怠けた犬を飛び越える"),
			// reverse: 訳文 "ウェブサイトからインストーラーを..." にヒット
			makeEntry("rev", "Download the installer from the website", "ウェブサイトからインストーラーをダウンロードしてください"),
		];
		const store = new StubTmxStore(entries);
		const result = searchTmBidirectional(
			"The quick brown fox jumps over the lazy dog",
			"ウェブサイトからインストーラーをダウンロードしてください",
			store as never,
			defaultOptions(),
		);
		const tuids = result.map((m) => m.sentenceHash);
		assert.ok(tuids.includes("fwd"), "原文側ヒットが含まれること");
		assert.ok(tuids.includes("rev"), "訳文側ヒットが含まれること");
	});

	test("訳文側ヒットの結果も source=原文言語 / target=訳文言語 の向きで返る", () => {
		const entries = [
			makeEntry("rev", "Download the installer from the website", "ウェブサイトからインストーラーをダウンロードしてください"),
		];
		const store = new StubTmxStore(entries);
		const result = searchTmBidirectional(
			"Totally unrelated source text here",
			"ウェブサイトからインストーラーをダウンロードしてください",
			store as never,
			defaultOptions(),
		);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].source, "Download the installer from the website", "source は原文言語側であること");
		assert.strictEqual(
			result[0].target,
			"ウェブサイトからインストーラーをダウンロードしてください",
			"target は訳文言語側であること",
		);
	});

	test("両方向でヒットした同一エントリは tuid で重複排除される", () => {
		const entries = [
			makeEntry("both", "Download the installer from the website", "ウェブサイトからインストーラーをダウンロードしてください"),
		];
		const store = new StubTmxStore(entries);
		const result = searchTmBidirectional(
			"Download the installer from the website",
			"ウェブサイトからインストーラーをダウンロードしてください",
			store as never,
			defaultOptions(),
		);
		assert.strictEqual(result.filter((m) => m.sentenceHash === "both").length, 1);
	});

	test("合計件数が maxReferences で cap される", () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			makeEntry(`t${i}`, `Sentence number ${i} with enough text to match`, `十分な長さの文テキスト番号 ${i} です`),
		);
		const store = new StubTmxStore(entries);
		const result = searchTmBidirectional(
			"Sentence number one with enough text to match here",
			"十分な長さの文テキスト番号一です本文はこちら",
			store as never,
			defaultOptions({ maxReferences: 3 }),
		);
		assert.ok(result.length <= 3, `maxReferences(3) を超えないこと: 実際は${result.length}件`);
	});

	test("訳文側検索では原文言語 variant の無いエントリが除外される（対訳が揃うもののみ）", () => {
		const entries = [
			// ja のみ（en variant なし）→ reverse でヒットしても対訳が無いので除外
			makeEntry("jaOnly", undefined, "ウェブサイトからインストーラーをダウンロードしてください"),
		];
		const store = new StubTmxStore(entries);
		const result = searchTmBidirectional(
			"Unrelated source text goes here",
			"ウェブサイトからインストーラーをダウンロードしてください",
			store as never,
			defaultOptions(),
		);
		assert.deepStrictEqual(result, []);
	});

	test("どちらにもヒットしなければ空配列を返す", () => {
		const entries = [makeEntry("t1", "Completely unrelated database migration script", "データベース移行スクリプト")];
		const store = new StubTmxStore(entries);
		const result = searchTmBidirectional(
			"The authentication flow uses OAuth tokens",
			"認証フローは検証にトークンを使います",
			store as never,
			defaultOptions(),
		);
		assert.deepStrictEqual(result, []);
	});
});
