/**
 * @file term-senses.test.ts
 * @description 同じ原語の訳し分け（用語集に同じ語の行が複数ある形。ADR-261108-06）のテスト。
 * 1行を1つの意味として扱い、context をその意味を使う条件として、
 * 保存・指示文・検証・AIレビュー・展開のどこでも1つにまとめて扱うことを固定する。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { extractBidirectionalTerms } from "../../../../commands/ai-review/review-term-extractor";
import { selectExpandableTerms } from "../../../../commands/term/command-expand";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";
import { TermsRepositoryCSV } from "../../../../commands/term/terms-repository-csv";
import { TERM_SENSES_NOTE, extractRelevantTerms, termsToJson } from "../../../../commands/trans/term-extractor";
import { toLintTerms } from "../../../../commands/validate/validate-command";
import { lintUnitPair } from "../../../../core/term/term-lint";
import type { TransPair } from "../../../../infra/config/configuration";

const pair: TransPair = { sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" };

const settingsNoun = TermEntry.create("名詞。画面や項目としての設定", {
	ja: LangTerm.create("設定"),
	en: LangTerm.create("settings"),
});
const settingsVerb = TermEntry.create("動詞「設定する」", {
	ja: LangTerm.create("設定"),
	en: LangTerm.create("configure", ["configured", "configuring"]),
});
const relay = TermEntry.create("", {
	ja: LangTerm.create("中継"),
	en: LangTerm.create("relay"),
});

suite("用語集の訳し分け", () => {
	suite("同じ意味かどうかの判定", () => {
		test("同じ語でも、context が違い訳語が食い違えば別の意味として扱う", () => {
			assert.equal(TermEntry.isSameEntry(settingsNoun, settingsVerb, "ja"), false);
		});

		test("同じ語で訳語の空欄を埋めるだけの候補は、context が違っても同じ意味として扱う", () => {
			const fill = TermEntry.create("別の例文", { ja: LangTerm.create("設定"), "zh-hans": LangTerm.create("设置") });
			assert.equal(TermEntry.isSameEntry(settingsNoun, fill, "ja"), true);
		});

		test("基準言語の欄が空の行でも、context が違い訳語が食い違えば別の意味として扱う", () => {
			const finance = TermEntry.create("金融機関", { en: LangTerm.create("bank"), de: LangTerm.create("Bank") });
			const river = TermEntry.create("川岸", { en: LangTerm.create("bank"), de: LangTerm.create("Ufer") });
			assert.equal(TermEntry.isSameEntry(finance, river, "ja"), false);
		});

		test("意味が複数ある語では、context が一致する行を選ぶ", () => {
			const fillVerb = TermEntry.create("動詞「設定する」", {
				ja: LangTerm.create("設定"),
				"zh-hans": LangTerm.create("配置"),
			});
			assert.equal(TermEntry.findSameEntryIndex([settingsNoun, settingsVerb], fillVerb, "ja"), 1);
		});
	});

	suite("保存", () => {
		const testDir = path.join(__dirname, "../../workspace/terms");
		const testFilePath = path.join(testDir, "test-senses.csv");
		const pairs: TransPair[] = [pair];

		setup(() => {
			fs.mkdirSync(testDir, { recursive: true });
		});
		teardown(() => {
			if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
		});

		test("同じ語の意味を足しても、もとの意味の訳語を上書きしない", async () => {
			const repository = await TermsRepositoryCSV.create(testFilePath, pairs, "ja");
			await repository.Merge([settingsNoun], pairs);
			await repository.Merge([settingsVerb], pairs);
			const entries = await repository.getAllEntries();
			assert.deepEqual(
				entries.map((e) => e.languages.en.term),
				["settings", "configure"],
			);
		});

		test("同じ語の行が2つあるファイルを読み書きしても、両方の行が残る", async () => {
			const repository = await TermsRepositoryCSV.create(testFilePath, pairs, "ja");
			await repository.Merge([settingsNoun, settingsVerb], pairs);
			await repository.save();

			const reloaded = await TermsRepositoryCSV.load(testFilePath);
			const entries = await reloaded.getAllEntries();
			assert.equal(entries.length, 2);
			assert.deepEqual(
				entries.map((e) => e.context),
				["名詞。画面や項目としての設定", "動詞「設定する」"],
			);
		});
	});

	suite("指示文", () => {
		test("同じ語の意味をまとめ、context を使い分けの条件（when）として載せる", () => {
			const terms = extractRelevantTerms("中継を設定する。", [settingsNoun, settingsVerb, relay], "ja", "en");
			const text = termsToJson(terms);
			const [json, note] = text.split(`\n${TERM_SENSES_NOTE}`);
			assert.equal(note, "", "訳し分けのある語があれば、使い分けの指示が JSON の後ろに付くこと");
			assert.deepEqual(JSON.parse(json), [
				{
					term: "設定",
					senses: [
						{ translation: "settings", when: "名詞。画面や項目としての設定" },
						{ translation: "configure", when: "動詞「設定する」" },
					],
				},
				{ term: "中継", translation: "relay" },
			]);
		});

		test("片方の意味の行にしか無い表記揺れで当たっても、全部の意味を渡す", () => {
			const noun = TermEntry.create("名詞", { ja: LangTerm.create("設定", ["セッティング"]), en: LangTerm.create("settings") });
			const verb = TermEntry.create("動詞", { ja: LangTerm.create("設定"), en: LangTerm.create("configure") });
			const terms = extractRelevantTerms("セッティングしてください。", [noun, verb], "ja", "en");
			assert.deepEqual(
				terms.map((t) => t.translation),
				["settings", "configure"],
			);
		});

		test("同じ訳語でも context が違う行は、それぞれの意味として残す", () => {
			const screen = TermEntry.create("画面", { ja: LangTerm.create("設定"), en: LangTerm.create("settings") });
			const file = TermEntry.create("設定ファイル", { ja: LangTerm.create("設定"), en: LangTerm.create("settings") });
			const verb = TermEntry.create("動詞", { ja: LangTerm.create("設定"), en: LangTerm.create("configure") });
			const terms = extractRelevantTerms("設定する。", [screen, file, verb], "ja", "en");
			const [json] = termsToJson(terms).split(`\n${TERM_SENSES_NOTE}`);
			assert.deepEqual(JSON.parse(json)[0].senses, [
				{ translation: "settings", when: "画面" },
				{ translation: "settings", when: "設定ファイル" },
				{ translation: "configure", when: "動詞" },
			]);
		});

		test("訳し分けの無い用語集では、これまでと同じ形のままで指示を足さない", () => {
			const terms = extractRelevantTerms("中継する。", [relay], "ja", "en");
			const text = termsToJson(terms);
			assert.ok(!text.includes(TERM_SENSES_NOTE));
			assert.deepEqual(JSON.parse(text), [{ term: "中継", translation: "relay" }]);
		});
	});

	suite("検証（term-lint）", () => {
		test("どちらの意味の訳語を使っていても違反にしない", () => {
			const terms = toLintTerms([settingsNoun, settingsVerb], pair);
			assert.equal(terms.length, 1, "同じ語は1つにまとめること");
			assert.deepEqual(lintUnitPair("項目を設定する。", "Please configure the item.", terms), []);
			assert.deepEqual(lintUnitPair("設定を開く。", "Open the settings.", terms), []);
			assert.deepEqual(lintUnitPair("値を設定した。", "The value was configured.", terms), []);
		});

		test("どの意味の訳語も無ければ違反にし、期待訳語には全部の意味を並べる", () => {
			const violations = lintUnitPair("設定を開く。", "Open the preferences.", toLintTerms([settingsNoun, settingsVerb], pair));
			assert.equal(violations.length, 1);
			assert.deepEqual(violations[0].expectedVariants, ["settings", "configure", "configured", "configuring"]);
		});
	});

	suite("AIレビュー", () => {
		test("訳文側で1つの意味だけが当たっても、全部の意味を渡す", () => {
			const terms = extractBidirectionalTerms("x", "Open the settings.", [settingsNoun, settingsVerb], "ja", "en");
			assert.deepEqual(
				terms.map((t) => t.translation),
				["settings", "configure"],
			);
		});
	});

	suite("展開（term.expand）", () => {
		test("訳し分けのある語は AI に展開させず、人が埋める残りとして数える", () => {
			const zh = "zh-hans";
			const noun = TermEntry.create("名詞", { ja: LangTerm.create("設定") });
			const verb = TermEntry.create("動詞", { ja: LangTerm.create("設定") });
			const plain = TermEntry.create("", { ja: LangTerm.create("中継") });
			const { termsToExpand, leftForHuman } = selectExpandableTerms([noun, verb, plain], "ja", zh);
			assert.deepEqual(
				termsToExpand.map((e) => e.languages.ja.term),
				["中継"],
			);
			assert.equal(leftForHuman, 2);
		});
	});
});
