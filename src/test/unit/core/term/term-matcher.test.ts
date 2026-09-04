/**
 * @file term-matcher.test.ts
 * @description 用語照合の範囲づくり（stripCodeSegments）のテスト
 *
 * CommonMark のコードスパンはバッククォートを何個並べてもよく、閉じるのは同じ個数である。
 * 1個決め打ちで除去していたため、偶数個で囲んだときに開きの対と閉じの対だけが消えて
 * **中身が残っていた**（実測: ``ノート`` が「ノート」を残した）。コードの中の語に
 * 「この語はこう訳せ」が付くのを防ぐのが目的なので、ここが漏れると目的を果たさない。
 */

import { strict as assert } from "node:assert";
import { stripCodeSegments } from "../../../../core/term/term-matcher";

suite("用語照合の範囲づくり", () => {
	suite("インラインコード（コードスパン）を除去する", () => {
		test("バッククォート1つで囲んだ中身は残らない", () => {
			assert.ok(!stripCodeSegments("設定画面から `ノート` を選ぶ。").includes("ノート"));
		});

		test("バッククォート2つで囲んだ中身も残らない", () => {
			// 1個決め打ちだと、開きの2個と閉じの2個だけが消えて中身が残っていた
			assert.ok(!stripCodeSegments("設定画面から ``ノート`` を選ぶ。").includes("ノート"));
		});

		test("バッククォート3つ・4つで囲んだ中身も残らない", () => {
			assert.ok(!stripCodeSegments("設定画面から ```ノート``` を選ぶ。").includes("ノート"));
			assert.ok(!stripCodeSegments("設定画面から ````ノート```` を選ぶ。").includes("ノート"));
		});

		test("中にバッククォートを含む書き方でも残らない", () => {
			assert.ok(!stripCodeSegments("書き方は `` `ノート` `` です。").includes("ノート"));
		});

		test("閉じていないバッククォートはコードスパンではないので消さない", () => {
			const stripped = stripCodeSegments("ノート ` は閉じていない");
			assert.ok(stripped.includes("ノート"));
		});

		test("同じ行に複数のコードスパンがあっても、あいだの本文は残る", () => {
			const stripped = stripCodeSegments("`tag:` に続けてタグ名を、`from:` に続けて日付を書く。");
			assert.ok(stripped.includes("に続けてタグ名を"), "コードスパンの外の本文は残ること");
			assert.ok(!stripped.includes("tag:"), "コードスパンの中は消えること");
		});

		test("コードでない本文はそのまま残る", () => {
			const text = "ノートは1か所に集まります。";
			assert.strictEqual(stripCodeSegments(text), text);
		});
	});

	suite("コードブロックの行を除去する", () => {
		test("フェンスの中の行は残らない", () => {
			const content = ["本文にはタグがあります。", "", "```js", "const ノート = load();", "```"].join("\n");
			const stripped = stripCodeSegments(content);

			assert.ok(stripped.includes("タグ"), "本文は残ること");
			assert.ok(!stripped.includes("ノート"), "フェンスの中は消えること");
		});

		test("チルダのフェンスでも消える", () => {
			const content = ["本文にはタグがあります。", "", "~~~js", "const ノート = load();", "~~~"].join("\n");
			const stripped = stripCodeSegments(content);

			assert.ok(stripped.includes("タグ"));
			assert.ok(!stripped.includes("ノート"));
		});
	});
});
