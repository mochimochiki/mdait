import * as assert from "node:assert";
import { rankTmEntries } from "../../../../core/tm/tm-ranker";
import type { RankOptions, ScoredTmEntry } from "../../../../core/tm/tm-ranker";
import type { TmEntry } from "../../../../core/tm/types";

function makeEntry(tuid: string, enText: string, jaText?: string, weight = 1): TmEntry {
	const variants = new Map<string, { text: string }>();
	variants.set("en", { text: enText });
	if (jaText !== undefined) {
		variants.set("ja", { text: jaText });
	}
	return {
		tuid,
		primary: enText,
		weight,
		variants,
	};
}

const OPTS_EN: RankOptions = { lang: "en", topK: 3, lambda: 1.0 };

suite("rankTmEntries", () => {
	test("空の candidates は空配列を返す", () => {
		const result = rankTmEntries("Download the installer", [], OPTS_EN);
		assert.deepStrictEqual(result, []);
	});

	test("lang variant を持たない candidates は除外される", () => {
		const entries = [makeEntry("t1", "Hello world")]; // ja variant なし
		const result = rankTmEntries("Hello world", entries, { lang: "ja", topK: 3, lambda: 1.0 });
		assert.strictEqual(result.length, 0);
	});

	test("lambda=1.0 のとき querySim 降順と一致する", () => {
		// クエリ "Download the installer"
		// e1: "Download the installer" (完全一致 → Jaccard=1.0)
		// e2: "Install the application" (部分的に一致)
		// e3: "Completely unrelated xyz" (ほぼ不一致)
		const entries = [
			makeEntry("t3", "Completely unrelated xyz"),
			makeEntry("t2", "Install the application"),
			makeEntry("t1", "Download the installer"),
		];
		const result = rankTmEntries("Download the installer", entries, { lang: "en", topK: 3, lambda: 1.0 });
		assert.strictEqual(result.length, 3);
		// 完全一致 t1 が top-1
		assert.strictEqual(result[0].tuid, "t1");
		// score が降順であること
		assert.ok(result[0].score >= result[1].score);
		assert.ok(result[1].score >= result[2].score);
	});

	test("クエリに最も近い候補が top-1 に選ばれる", () => {
		const entries = [
			makeEntry("t1", "The quick brown fox jumps over the lazy dog"),
			makeEntry("t2", "Download the installer from the website"),
			makeEntry("t3", "Please install the software package"),
		];
		const result = rankTmEntries("Download the installer from the website", entries, {
			lang: "en",
			topK: 3,
			lambda: 1.0,
		});
		assert.strictEqual(result[0].tuid, "t2");
	});

	test("topK 件を超えて返さない", () => {
		const entries = [
			makeEntry("t1", "First sentence here"),
			makeEntry("t2", "Second sentence here"),
			makeEntry("t3", "Third sentence here"),
			makeEntry("t4", "Fourth sentence here"),
			makeEntry("t5", "Fifth sentence here"),
		];
		const result = rankTmEntries("First sentence here", entries, { lang: "en", topK: 2, lambda: 1.0 });
		assert.strictEqual(result.length, 2);
	});

	test("candidates が topK より少ない場合は全件返す", () => {
		const entries = [makeEntry("t1", "Hello world"), makeEntry("t2", "Goodbye world")];
		const result = rankTmEntries("Hello world", entries, { lang: "en", topK: 5, lambda: 1.0 });
		assert.strictEqual(result.length, 2);
	});

	test("ScoredTmEntry に score フィールドが付与される", () => {
		const entries = [makeEntry("t1", "Download the installer")];
		const result = rankTmEntries("Download the installer", entries, OPTS_EN);
		assert.strictEqual(result.length, 1);
		assert.ok(typeof result[0].score === "number");
		assert.ok(result[0].score >= 0 && result[0].score <= 1);
	});

	test("MMR lambda=0.0 のとき2番目以降は1番目と異なる候補を優先する", () => {
		// t1 と t2 は非常に類似（"hello world test"）、t3 は異なる（"goodbye planet"）
		// lambda=0.0 では多様性重視なので t1 選択後、t3 が t2 より優先されるはず
		const entries = [
			makeEntry("t1", "hello world test"),
			makeEntry("t2", "hello world test"), // t1 と同一テキスト
			makeEntry("t3", "goodbye planet xyz"),
		];
		const result = rankTmEntries("hello world test", entries, { lang: "en", topK: 3, lambda: 0.0 });
		// 2番目に t3 が選ばれるか、または t2（完全一致重複）より t3 が優先される
		// t1 選択後、t2 は t1 と sim=1.0 なので MMR score = 0 - 1.0 = -1.0
		// t3 は t1 と sim が低いので MMR score = 0 - low ≈ -low > -1.0
		assert.strictEqual(result.length, 3);
		const secondTuid = result[1].tuid;
		assert.strictEqual(secondTuid, "t3");
	});

	test("クエリが3文字未満でも処理が完了する（trigram=空でも候補は返す）", () => {
		const entries = [makeEntry("t1", "Hello world")];
		// queryTrigrams が空 → Jaccard=0 → querySim=0 だが候補はそのまま返す
		const result = rankTmEntries("ab", entries, { lang: "en", topK: 3, lambda: 1.0 });
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].score, 0);
	});

	test("weight 補正により同一類似度なら高weightが優先される", () => {
		const entries = [
			makeEntry("low", "Download the installer", undefined, 0),
			makeEntry("high", "Download the installer", undefined, 1),
		];
		const result = rankTmEntries("Download the installer", entries, { lang: "en", topK: 2, lambda: 1.0 });
		assert.strictEqual(result[0].tuid, "high");
		assert.ok(result[0].score > result[1].score);
	});
});
