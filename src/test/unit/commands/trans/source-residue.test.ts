/**
 * @file source-residue.test.ts
 * @description
 *   訳文に原文の仮名が残っていないかを調べる `findSourceResidue` の検証。
 *   実例は Haiku で日本語→簡体字中国語を訳した録音から取った（13. トラブルシューティング）。
 *   AI は原文を受け取っていたのに、文の頭・表の見出し・章名を訳さずに返していた。
 */
import { strict as assert } from "node:assert";
import {
	findSourceResidue,
	formatSourceResidueReason,
	residueAllowedTerms,
	shouldCheckSourceResidue,
} from "../../../../commands/trans/source-residue";
import { TermEntry } from "../../../../commands/term/term-entry";

suite("findSourceResidue", () => {
	suite("実例（日本語→簡体字中国語）", () => {
		test("冒頭だけ日本語のまま残った文を訳し残しとして拾う", () => {
			const translated =
				"# 13. 故障排除\n\n本章では，GL-7 数据记录仪不按预期工作时的调查方法进行说明。首先在症状表中查找相近的项目。";

			const result = findSourceResidue("ja", "zh-hans", translated);

			assert.strictEqual(result.found, true);
			assert.deepStrictEqual(result.fragments, ["本章では"]);
		});

		test("表の見出しと章名が日本語のまま残ったら両方を拾う", () => {
			const translated = [
				"### 关于读数的故障症状",
				"",
				"| 症状 | 考えられる原因 | 対処 |",
				"|---|---|---|",
				"| 读数显示为「---」 | 传感器未连接或断线 | 确认输入插槽和传感器的连接 |",
				"| 温度偏离实际值 | 校准期限已过期 | 进行校准。步骤见「12. 保守と校正」 |",
			].join("\n");

			const result = findSourceResidue("ja", "zh-hans", translated);

			assert.strictEqual(result.found, true);
			assert.deepStrictEqual(result.fragments, ["考えられる原因", "保守と校正"]);
		});

		test("きちんと訳された中国語は訳し残しとみなさない", () => {
			const translated = [
				"| 症状 | 考虑的原因 | 处理 |",
				"|---|---|---|",
				"| 每次启动时日期和时间都变为初始值 | 内置电池耗尽 | 更换电池。步骤在「12. 保养和校准」中 |",
			].join("\n");

			const result = findSourceResidue("ja", "zh-hans", translated);

			assert.strictEqual(result.found, false);
			assert.deepStrictEqual(result.fragments, []);
		});

		test("漢字だけの日本語の字体（内蔵・初期値）は中国語と見分けられないので拾わない", () => {
			const result = findSourceResidue("ja", "zh-hans", "将内蔵电池的开关设为OFF。不要初期化本体。");

			assert.strictEqual(result.found, false);
		});
	});

	suite("訳す対象ではない部分", () => {
		test("コードブロックとインラインコードの中の仮名は拾わない", () => {
			const translated = "运行以下命令。\n\n```bash\necho こんにちは\n```\n\n设置 `モード=自動` 后重启。";

			assert.strictEqual(findSourceResidue("ja", "zh", translated).found, false);
		});

		test("URL・リンクの行き先・HTML コメントの中の仮名は拾わない", () => {
			const translated = [
				"<!-- mdait hash from:abc メモ -->",
				"详见[手册](https://example.com/マニュアル/設定)。",
				"也可访问 https://example.jp/ヘルプ 。",
			].join("\n");

			assert.strictEqual(findSourceResidue("ja", "zh", translated).found, false);
		});

		test("山括弧で囲んだだけの本文はタグとみなさず、中の仮名を拾う", () => {
			const result = findSourceResidue("ja", "zh", "请选择 <設定を開く>。");

			assert.deepStrictEqual(result.fragments, ["設定を開く"]);
		});

		test("HTML タグと自動リンクの中の仮名は拾わない", () => {
			const translated = [
				'<img alt="設定画面" src="a.png">',
				"<span>设置</span>",
				"详见 <https://example.com/マニュアル> 或 <mailto:サポート@example.com>。",
			].join("\n");

			assert.strictEqual(findSourceResidue("ja", "zh", translated).found, false);
		});

		test("URL のすぐ後ろに続く全角の句読点と本文は URL とみなさず、中の仮名を拾う", () => {
			const result = findSourceResidue("ja", "zh", "访问 https://example.com。設定を開く。");

			assert.deepStrictEqual(result.fragments, ["設定を開く"]);
		});

		test("URL のホストの直後に空白なしで続く本文は URL とみなさず、中の仮名を拾う", () => {
			const result = findSourceResidue("ja", "zh", "访问 https://example.com設定を開く");

			assert.deepStrictEqual(result.fragments, ["設定を開く"]);
		});

		test("日本語を含む URL のパスは、全角の句読点の手前まで URL とみなす", () => {
			const result = findSourceResidue("ja", "zh", "访问 https://example.jp/ヘルプ/設定。それから再起動。");

			assert.deepStrictEqual(result.fragments, ["それから再起動"]);
		});

		test("中点と長音符だけでは訳し残しとみなさない", () => {
			const result = findSourceResidue("ja", "zh", "列奥纳多・达・芬奇 —— 名画ー览");

			assert.strictEqual(result.found, false);
		});

		test("用語集で仮名のまま訳すと決めた製品名は拾わない", () => {
			const translated = "使用 ミルクボックス 管理数据。";

			assert.strictEqual(findSourceResidue("ja", "zh", translated, ["ミルクボックス"]).found, false);
			assert.deepStrictEqual(findSourceResidue("ja", "zh", translated).fragments, ["ミルクボックス"]);
		});

		test("用語集の製品名を外しても、ほかに残った仮名は拾う", () => {
			const translated = "使用 ミルクボックス 管理数据。设置は完了。";

			const result = findSourceResidue("ja", "zh", translated, ["ミルクボックス"]);

			assert.deepStrictEqual(result.fragments, ["设置は完了"]);
		});
	});

	suite("言語の組", () => {
		test("英語の訳文に残った仮名も拾う", () => {
			const result = findSourceResidue("ja", "en", "This chapter explains 調べ方 for the logger.");

			assert.deepStrictEqual(result.fragments, ["調べ方"]);
		});

		test("訳文も日本語なら調べない", () => {
			assert.strictEqual(shouldCheckSourceResidue("ja", "ja-JP"), false);
			assert.strictEqual(findSourceResidue("ja", "ja-JP", "これは日本語です。").found, false);
		});

		test("原文が日本語でなければ調べない", () => {
			assert.strictEqual(shouldCheckSourceResidue("en", "zh"), false);
			assert.strictEqual(findSourceResidue("en", "zh", "カタカナを含む訳文").found, false);
		});

		test("言語コードの大文字小文字と地域の違いを吸収する", () => {
			assert.strictEqual(shouldCheckSourceResidue("ja-JP", "zh_Hans"), true);
			assert.strictEqual(shouldCheckSourceResidue("JA", "en"), true);
		});
	});

	suite("抜き出し", () => {
		test("同じ箇所は1度だけ、最大5件まで返す", () => {
			const translated = "あ。あ。い。う。え。お。か。";

			assert.deepStrictEqual(findSourceResidue("ja", "zh", translated).fragments, ["あ", "い", "う", "え", "お"]);
		});

		test("理由の文言に抜き出した箇所をかぎかっこで並べる", () => {
			const message = formatSourceResidueReason(["本章では", "保守と校正"]);

			assert.ok(message.includes("「本章では」, 「保守と校正」"), message);
		});
	});

	suite("residueAllowedTerms", () => {
		const glField = TermEntry.create("製品の機能名", {
			ja: { term: "GL Field", variants: [] },
			zh: { term: "GL Field", variants: ["GL フィールド"] },
		});
		const other = TermEntry.create("", {
			ja: { term: "ミルクボックス", variants: [] },
			zh: { term: "ミルクボックス", variants: [] },
		});
		const sourceOnly = TermEntry.create("", { ja: { term: "設定", variants: [] } });

		test("訳文の言語の訳語と variants を、用語集の全体から集める", () => {
			assert.deepStrictEqual(residueAllowedTerms([glField, other, sourceOnly], "zh"), [
				"GL Field",
				"GL フィールド",
				"ミルクボックス",
			]);
		});

		test("旧訳文で原語が variant に置き換わっていた用語も、改訂後の訳文で仮名を許す", () => {
			// 改訂の旧訳文は「GL フィールド」と書いており、原語「GL Field」を含まない。
			// ユニットの本文から用語を拾う作りでは、この用語が許す語から落ちていた
			const revised = "在 GL フィールド 中设置。";

			assert.strictEqual(findSourceResidue("ja", "zh", revised, residueAllowedTerms([glField], "zh")).found, false);
		});
	});
});
