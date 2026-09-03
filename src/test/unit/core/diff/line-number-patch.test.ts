import * as assert from "node:assert";
import { applyLineNumberPatch, applyRevisionPatch, numberLinesForPatch } from "../../../../core/diff/diff-generator";

/**
 * 行番号方式の当てはめ（ADR-260903-01）。
 *
 * 旧来の `=`/`-`/`+` 形式は「前回訳文から3行を逐語で写す」ことを要求していて、
 * 目印が Markdown とぶつかっていた（空行に目印を付けられない・箇条書きの `-` と
 * 削除の `-` が区別できない・表の行が切れる）。行番号で指す形式はその要求そのものを
 * 持たないので、これらの衝突が構造的に起きない。
 *
 * ここで守るのは**黙って壊れないこと**。当てはめ器が親切に振る舞って
 * 「当たったように見えるが別の文書ができる」のがいちばん危ない。
 */
suite("行番号方式のパッチ", () => {
	const previous = ["## Features", "", "- Translation support", "- Sync support", "- Term management"].join("\n");

	suite("当たる場合", () => {
		test("1行を置き換える", () => {
			const result = applyLineNumberPatch(previous, "REPLACE 4\n- Real-time sync\nEND");
			assert.ok(result.ok);
			assert.strictEqual(
				result.text,
				["## Features", "", "- Translation support", "- Real-time sync", "- Term management"].join("\n"),
			);
		});

		test("範囲で置き換える", () => {
			const result = applyLineNumberPatch(previous, "REPLACE 3-4\n- Everything\nEND");
			assert.ok(result.ok);
			assert.strictEqual(result.text, ["## Features", "", "- Everything", "- Term management"].join("\n"));
		});

		test("行の後ろへ差し込む", () => {
			const result = applyLineNumberPatch(previous, "INSERT AFTER 5\n- Glossary\nEND");
			assert.ok(result.ok);
			assert.strictEqual(result.text.split("\n").at(-1), "- Glossary");
		});

		test("先頭へ差し込む（INSERT AFTER 0）", () => {
			const result = applyLineNumberPatch(previous, "INSERT AFTER 0\n# Title\nEND");
			assert.ok(result.ok);
			assert.strictEqual(result.text.split("\n")[0], "# Title");
		});

		test("行を消す", () => {
			const result = applyLineNumberPatch(previous, "DELETE 4\nEND");
			assert.ok(result.ok);
			assert.ok(!result.text.includes("Sync support"));
			assert.strictEqual(result.text.split("\n").length, 4);
		});

		test("離れた複数の指示を、順序に関係なく正しく当てる", () => {
			// 前から当てると行番号がずれる。後ろから当てているかを見る
			const result = applyLineNumberPatch(previous, "REPLACE 3\n- A\nEND\nREPLACE 5\n- C\nEND");
			assert.ok(result.ok);
			assert.strictEqual(result.text, ["## Features", "", "- A", "- Sync support", "- C"].join("\n"));
		});

		test("指示を書いた順が逆でも結果は同じ", () => {
			const forward = applyLineNumberPatch(previous, "REPLACE 3\n- A\nEND\nREPLACE 5\n- C\nEND");
			const backward = applyLineNumberPatch(previous, "REPLACE 5\n- C\nEND\nREPLACE 3\n- A\nEND");
			assert.ok(forward.ok && backward.ok);
			assert.strictEqual(forward.text, backward.text);
		});

		test("小文字で書かれた指示も読む", () => {
			const result = applyLineNumberPatch(previous, "replace 4\n- Real-time sync\nend");
			assert.ok(result.ok);
			assert.ok(result.text.includes("Real-time sync"));
		});

		test("箇条書きや水平線を本文に置いても、指示と取り違えない", () => {
			// 旧形式ではここが弱点だった（`-` が削除の目印と衝突する）
			const result = applyLineNumberPatch(previous, "REPLACE 4\n- Sync support\n---\n+ extra\nEND");
			assert.ok(result.ok);
			assert.ok(result.text.includes("---"));
			assert.ok(result.text.includes("+ extra"));
		});

		test("空行へ置き換えられる（旧形式では目印を付けられなかった）", () => {
			const result = applyLineNumberPatch(previous, "REPLACE 2\n\nEND");
			assert.ok(!result.ok);
			// 空行を空行にしても何も変わらないので no-changes。壊れないことが要点
			assert.strictEqual(result.reason, "no-changes");
		});
	});

	suite("当てない場合（黙って壊さない）", () => {
		test("空のパッチ", () => {
			assert.deepStrictEqual(applyLineNumberPatch(previous, "   "), { ok: false, reason: "empty-patch" });
		});

		test("指示が1つも無ければ書式違いとして返す", () => {
			assert.deepStrictEqual(applyLineNumberPatch(previous, "just some prose"), {
				ok: false,
				reason: "unrecognized-format",
			});
		});

		test("END で閉じていないブロックは飲み込まない", () => {
			// 飲み込むと「残り全部が本文」になり、訳文の末尾が丸ごと入れ替わる
			assert.deepStrictEqual(applyLineNumberPatch(previous, "REPLACE 4\n- Real-time sync"), {
				ok: false,
				reason: "unterminated-block",
			});
		});

		test("存在しない行を指したら当てない", () => {
			assert.deepStrictEqual(applyLineNumberPatch(previous, "REPLACE 99\nnope\nEND"), {
				ok: false,
				reason: "bad-range",
			});
		});

		test("範囲が逆順なら当てない", () => {
			assert.deepStrictEqual(applyLineNumberPatch(previous, "REPLACE 4-2\nnope\nEND"), {
				ok: false,
				reason: "bad-range",
			});
		});

		test("0 行目の置換は当てない（差し込みだけが 0 を許す）", () => {
			assert.deepStrictEqual(applyLineNumberPatch(previous, "REPLACE 0\nnope\nEND"), {
				ok: false,
				reason: "bad-range",
			});
		});

		test("同じ行を2つの指示が取り合っていたら当てない", () => {
			// 後ろから当てる実装なので、重なったまま進めると順序で結果が変わる。
			// 「当たったように見えて別の文書ができる」のを防ぐ
			assert.deepStrictEqual(applyLineNumberPatch(previous, "REPLACE 3-5\nA\nEND\nREPLACE 4-5\nB\nEND"), {
				ok: false,
				reason: "overlapping-ops",
			});
		});

		test("結果が元と同じなら no-changes", () => {
			assert.deepStrictEqual(applyLineNumberPatch(previous, "REPLACE 4\n- Sync support\nEND"), {
				ok: false,
				reason: "no-changes",
			});
		});
	});

	suite("形式は引数で決まり、中身から推測しない", () => {
		test("行番号のパッチを prefixed として読ませても、当たったことにしない", () => {
			// **推測させると危ない。** prefixed の当てはめ器はプレフィックスの無い行を
			// 黙って文脈行として扱うので、別形式でも「読めてしまう」
			const result = applyRevisionPatch(previous, "REPLACE 4\n- Real-time sync\nEND", "prefixed");
			assert.ok(!result.ok, `prefixed として読んで当たってしまった: ${JSON.stringify(result)}`);
		});

		test("旧形式のパッチを linenum として読ませても、当たったことにしない", () => {
			const result = applyRevisionPatch(previous, "=## Features\n-- Sync support\n+- Real-time sync", "linenum");
			assert.deepStrictEqual(result, { ok: false, reason: "unrecognized-format" });
		});

		test("形式を指定すれば、それぞれ正しく当たる", () => {
			const byLine = applyRevisionPatch(previous, "REPLACE 4\n- Real-time sync\nEND", "linenum");
			const byPrefix = applyRevisionPatch(
				previous,
				"=- Translation support\n-- Sync support\n+- Real-time sync\n=- Term management",
				"prefixed",
			);
			assert.ok(byLine.ok && byPrefix.ok);
			assert.strictEqual(byLine.text, byPrefix.text);
		});
	});

	suite("モデルへ渡す形", () => {
		test("1始まりの行番号とタブを付ける", () => {
			assert.strictEqual(numberLinesForPatch("a\nb"), "1\ta\n2\tb");
		});

		test("空行にも番号が付く（行がずれない）", () => {
			assert.strictEqual(numberLinesForPatch("a\n\nb"), "1\ta\n2\t\n3\tb");
		});
	});
});
