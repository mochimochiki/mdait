/**
 * @file translation-checker.test.ts
 * @description TranslationCheckerのテスト実装
 * markdown-itベースの構造比較による翻訳品質チェックロジックの検証
 */

import { strict as assert } from "node:assert";
import { TranslationChecker } from "../../../../commands/trans/translation-checker";
import { applyLineNumberPatch } from "../../../../core/diff/diff-generator";

suite("TranslationChecker", () => {
	const checker = new TranslationChecker();

	suite("checkTranslationQuality", () => {
		test("完全一致する構造は問題なし", () => {
			const source = "# Title\n\nText with **bold**.\n\n- Item 1\n- Item 2\n\n```js\ncode\n```";
			const translation = "# タイトル\n\n**太字**のテキスト。\n\n- 項目1\n- 項目2\n\n```js\ncode\n```";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("見出しレベルが不一致の場合は確認推奨", () => {
			const source = "# Title\n\n## Subtitle";
			const translation = "# タイトル\n\n### サブタイトル";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "heading_mismatch"));
			assert.ok(result.reasons.some((r) => r.message.includes("見出しレベル2")));
			assert.ok(result.reasons.some((r) => r.message.includes("見出しレベル3")));
		});

		test("見出し数が不一致の場合は確認推奨", () => {
			const source = "# Title\n\n## Section 1\n\n## Section 2";
			const translation = "# タイトル\n\n## セクション1";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "heading_mismatch"));
			assert.ok(result.reasons.some((r) => r.message.includes("見出しレベル2")));
		});

		test("リスト項目数が一致する場合は問題なし", () => {
			const source = "- Item 1\n- Item 2\n- Item 3";
			const translation = "- アイテム1\n- アイテム2\n- アイテム3";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("リスト項目数が不一致の場合は確認推奨", () => {
			const source = "- Item A\n- Item B\n- Item C";
			const translation = "- アイテムA\n- アイテムB";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.strictEqual(result.reasons.length, 1);
			assert.strictEqual(result.reasons[0].category, "list_mismatch");
			assert.ok(result.reasons[0].message.includes("3項目"));
			assert.ok(result.reasons[0].message.includes("2項目"));
		});

		test("コードブロック数が一致する場合は問題なし", () => {
			const source = "Here is code:\n```js\nconst x = 1;\n```\nAnd more:\n```python\ny = 2\n```";
			const translation = "コードです:\n```js\nconst x = 1;\n```\nさらに:\n```python\ny = 2\n```";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("コードブロック数が不一致の場合は確認推奨", () => {
			const source = "Here is code:\n```js\nconst x = y;\n```";
			const translation = "コードです。";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "code_block_mismatch"));
			assert.ok(result.reasons.some((r) => r.message.includes("1個")));
			assert.ok(result.reasons.some((r) => r.message.includes("0個")));
		});

		test("引用ブロック数が不一致の場合は確認推奨", () => {
			const source = "> Quote 1\n\n> Quote 2";
			const translation = "> 引用1";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "blockquote_mismatch"));
		});

		test("テーブル数が不一致の場合は確認推奨", () => {
			const source = "| A | B |\n|---|---|\n| 1 | 2 |";
			const translation = "データなし";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "table_mismatch"));
		});

		test("リンク数が不一致の場合は確認推奨", () => {
			const source = "See [link1](url1) and [link2](url2)";
			const translation = "[リンク1](url1)を参照";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "link_mismatch"));
		});

		test("画像数が不一致の場合は確認推奨", () => {
			const source = "![alt1](img1.png) and ![alt2](img2.png)";
			const translation = "![代替1](img1.png)";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "image_mismatch"));
		});

		test("複数の問題がある場合は全て検出", () => {
			const source = "# Title\n\n- Item A\n- Item B\n\n```\ncode\n```\n\n[link](url)";
			const translation = "## タイトル\n\n- アイテムA";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			// 見出しレベル不一致(H1->0, H2->1の2つ)、リスト数不一致(2->1)、コードブロック不一致(1->0)、リンク不一致(1->0)
			// = 合計5つの不一致
			assert.ok(result.reasons.length >= 5, `Expected at least 5 reasons, got ${result.reasons.length}`);
			assert.ok(
				result.reasons.some((r) => r.category === "heading_mismatch"),
				"Should detect heading mismatch",
			);
			assert.ok(
				result.reasons.some((r) => r.category === "list_mismatch"),
				"Should detect list mismatch",
			);
			assert.ok(
				result.reasons.some((r) => r.category === "code_block_mismatch"),
				"Should detect code block mismatch",
			);
			assert.ok(
				result.reasons.some((r) => r.category === "link_mismatch"),
				"Should detect link mismatch",
			);
		});

		test("番号付きリストも正しくカウントされる", () => {
			const source = "1. First item\n2. Second item\n3. Third item";
			const translation = "1. 最初の項目\n2. 第二の項目\n3. 第三の項目";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("ネストされたリストも正しくカウントされる", () => {
			const source = "- Item 1\n  - Nested 1\n  - Nested 2\n- Item 2";
			const translation = "- 項目1\n  - ネスト1\n  - ネスト2\n- 項目2";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});
	});

	suite("表の行数と引用の中の段落の数", () => {
		// 実例（Haiku・改訂の linenum 形式）。原文は E502 のあとに E404 を1行足しただけなのに、
		// モデルは `REPLACE 20`（E502 の行）の中に E502・E404・E901 の3行を書いた。
		// E901 は 21 行目に元からあるため、当てはめると E901 の行が2つになる。
		// テーブルの数は 1 対 1 のままなので、行数を比べないと見逃す。
		const errorTableRows = [
			"| E101 | Power | DC supply voltage drop | Check DC supply voltage and wiring |",
			"| E102 | Power | Built-in battery low | Replace battery |",
			"| E201 | Input | Sensor disconnected | Check input slot wiring |",
			"| E202 | Input | Reading out of range | Check sensor type and settings |",
			"| E203 | Input | Expansion pod not responding | Check expansion pod cable |",
			"| E301 | Storage | microSD card full | Move unnecessary files or replace card |",
			"| E302 | Storage | microSD write error | Reinsert card. If unresolved, replace it |",
			"| E401 | Communication | Cannot connect to Relay Hub | Check wired LAN or LTE connection |",
			"| E402 | Communication | Authentication key mismatch | Re-enter authentication key |",
			"| E403 | Communication | Failed to transfer to shared folder | Check shared folder location and permissions |",
			"| E501 | Script | Execution time exceeded | Simplify script processing |",
			"| E502 | Script | Nonexistent input slot specified | Review arguments for `reading` |",
		];
		const e901 = "| E901 | Main unit | Main unit internal error | Restart power. If unresolved, contact distributor |";
		const previousTranslation = [
			"## Error Code Reference",
			"",
			"Error codes are displayed on both the screen and in the event journal.",
			"",
			"The GL-7 main unit error codes are classified by the leading letter.",
			"",
			"| Code | Category | Meaning | Action |",
			"|---|---|---|---|",
			...errorTableRows,
			e901,
			"",
			"When power errors starting with E1 appear, other errors may cascade.",
			"",
		].join("\n");
		const revisedSource = [
			"## エラーコード一覧",
			"",
			"エラーコードは、画面と事象ログの両方に表示されます。",
			"",
			"GL-7 本体が表示するエラーコードは、先頭の英字で分類されています。",
			"",
			"| コード | 区分 | 意味 | 対処 |",
			"|---|---|---|---|",
			"| E101 | 電源 | 外部電源の電圧低下 | 外部電源の電圧と配線を確かめる |",
			"| E102 | 電源 | 内蔵電池の残量不足 | 電池を交換する |",
			"| E201 | 入力 | センサーの断線 | 入力スロットの配線を確かめる |",
			"| E202 | 入力 | 測定値が範囲外 | センサーの種類と設定を確かめる |",
			"| E203 | 入力 | 拡張ユニットの応答なし | 拡張ユニットのケーブルを確かめる |",
			"| E301 | 保存 | microSD の空き容量不足 | 不要なファイルを移すか、カードを替える |",
			"| E302 | 保存 | microSD の書き込みエラー | カードを入れ直す。直らなければ交換する |",
			"| E401 | 通信 | 中継ハブと接続できない | 有線 LAN または LTE の状態を確かめる |",
			"| E402 | 通信 | 認証キーが合わない | 認証キーを入れ直す |",
			"| E403 | 通信 | 共有フォルダへの転送の失敗 | 共有フォルダの場所と権限を確かめる |",
			"| E501 | スクリプト | 実行時間の超過 | スクリプトの処理を軽くする |",
			"| E502 | スクリプト | 存在しない入力スロットの指定 | `reading` の引数を見直す |",
			"| E404 | 通信 | 中継ハブのファームウェアが古い | ミドリクラウドの「機器の管理」画面から中継ハブを更新する |",
			"| E901 | 本体 | 本体内部の異常 | 電源を入れ直す。直らなければ販売店に連絡する |",
			"",
			"E1 から始まる電源のエラーが出ているときは、他のエラーも連鎖して出ることがあります。",
			"",
		].join("\n");
		const e404 =
			'| E404 | Communication | Relay Hub firmware is outdated | Update the Relay Hub from the "Device Management" screen in Midori Cloud |';
		const recordedPatch = ["REPLACE 20", errorTableRows[errorTableRows.length - 1], e404, e901, "END"].join("\n");

		test("改訂の当てはめで表の行が重複したら、表の数が同じでも行数の不一致として確認推奨にする", () => {
			const applied = applyLineNumberPatch(previousTranslation, recordedPatch);
			assert.ok(applied.ok, "パッチ自体は当たる（当てはめ器から見れば正しい指示）");
			assert.strictEqual(applied.text.split(e901).length - 1, 2, "E901 の行が2つになっている");

			const result = checker.checkTranslationQuality(revisedSource, applied.text);

			assert.strictEqual(result.needsReview, true);
			assert.ok(!result.reasons.some((r) => r.category === "table_mismatch"), "テーブルの数は一致している");
			const rowReason = result.reasons.find((r) => r.category === "table_row_mismatch");
			assert.ok(rowReason, "行数の不一致を報告する");
			assert.ok(rowReason.message.includes("原文15行"), rowReason.message);
			assert.ok(rowReason.message.includes("訳文16行"), rowReason.message);
		});

		test("改訂で足した行だけを訳文にも足したときは問題なし", () => {
			const correctPatch = ["INSERT AFTER 20", e404, "END"].join("\n");
			const applied = applyLineNumberPatch(previousTranslation, correctPatch);
			assert.ok(applied.ok);

			const result = checker.checkTranslationQuality(revisedSource, applied.text);

			assert.strictEqual(result.needsReview, false, JSON.stringify(result.reasons));
		});

		test("表が複数あるときは、何番目の表の行数が違うかを報告する", () => {
			const source = "| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 1 |\n| 2 |";
			const translation = "| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 1 |";

			const result = checker.checkTranslationQuality(source, translation);

			const rowReasons = result.reasons.filter((r) => r.category === "table_row_mismatch");
			assert.strictEqual(rowReasons.length, 1);
			assert.ok(rowReasons[0].message.includes("2番目のテーブル"), rowReasons[0].message);
		});

		test("テーブルの数が違うときは、行数の不一致を重ねて報告しない", () => {
			const source = "| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 1 |";
			const translation = "| B |\n|---|\n| 1 |\n| 2 |";

			const result = checker.checkTranslationQuality(source, translation);

			assert.ok(result.reasons.some((r) => r.category === "table_mismatch"));
			assert.ok(!result.reasons.some((r) => r.category === "table_row_mismatch"));
		});

		test("引用ブロックの数が同じでも、引用の中の段落の数が違えば確認推奨にする", () => {
			const source = "> **注意**\n>\n> 原因を特定せずに初期化しない。\n>\n> 記録した値が失われる。";
			const translation = "> **Caution**\n>\n> Do not initialize the device without identifying the cause.";

			const result = checker.checkTranslationQuality(source, translation);

			assert.ok(!result.reasons.some((r) => r.category === "blockquote_mismatch"));
			const reason = result.reasons.find((r) => r.category === "blockquote_paragraph_mismatch");
			assert.ok(reason, "引用の中の段落の数の不一致を報告する");
			assert.ok(reason.message.includes("原文3個"), reason.message);
			assert.ok(reason.message.includes("訳文2個"), reason.message);
		});

		test("引用の中の段落を訳文で1行に折り返しても、段落の数が同じなら問題なし", () => {
			const source = "> 一行目の文で\n> 二行目に続く文。";
			const translation = "> The first sentence continues in line two.";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false, JSON.stringify(result.reasons));
		});

		test("引用の遅延継続行を訳文で1行にまとめても、段落の数が同じなら問題なし", () => {
			const source = "> 引用\n続き";
			const translation = "> Quote continued";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false, JSON.stringify(result.reasons));
		});

		test("入れ子の引用で内側の段落が消えたら、確認推奨にする", () => {
			const source = "> 外側\n>\n> > 内側1\n> >\n> > 内側2";
			const translation = "> Outer\n>\n> > Inner 1 and 2";

			const result = checker.checkTranslationQuality(source, translation);

			assert.ok(result.reasons.some((r) => r.category === "blockquote_paragraph_mismatch"));
		});

		test("入れ子の引用は内側の段落を二重に数えず、段落の数が同じなら問題なし", () => {
			const source = "> 外側\n>\n> > 内側1\n> > 内側2";
			const translation = "> Outer\n>\n> > Inner 1\n> > Inner 2";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false, JSON.stringify(result.reasons));
		});
	});
});
