// frontmatter マーカー同期の冪等性に関する回帰テスト。
// 探索ハーネス（scripts/exploratory）が検出した2件の非冪等バグを単体で固定する:
//   Bug B: frontmatter のみのファイルで stringify のたびに末尾改行が増える
//   Bug A: _data のマーカーが更新されても _raw が古いまま残り、出力にマーカーが出ない

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../../core/markdown/front-matter";
import { markdownParser } from "../../../../core/markdown/parser";
import type { Configuration } from "../../../../infra/config/configuration";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

suite("frontmatter マーカー同期の冪等性", () => {
	suite("Bug B: frontmatter のみのファイル", () => {
		const md = '---\ntitle: "frontmatter のみ"\nweight: 20\nmdait:\n  front: ca4c6cc1\n---\n';

		test("stringify を繰り返しても末尾改行が増えない（冪等）", () => {
			const out1 = markdownParser.stringify(markdownParser.parse(md, makeConfig(2)));
			const out2 = markdownParser.stringify(markdownParser.parse(out1, makeConfig(2)));
			const out3 = markdownParser.stringify(markdownParser.parse(out2, makeConfig(2)));
			assert.strictEqual(out1, out2, "1→2 で非冪等");
			assert.strictEqual(out2, out3, "2→3 で非冪等");
		});

		test("末尾の改行はちょうど1つになる", () => {
			const out = markdownParser.stringify(markdownParser.parse(md, makeConfig(2)));
			assert.ok(out.endsWith("\n"), "末尾に改行がない");
			assert.ok(!out.endsWith("\n\n"), "末尾改行が2つ以上ある");
		});

		test("frontmatter のマーカーは保持される", () => {
			const out = markdownParser.stringify(markdownParser.parse(md, makeConfig(2)));
			assert.ok(/mdait:\s*\n\s*front:\s*ca4c6cc1/.test(out), "front マーカーが失われた");
		});
	});

	suite("Bug A: _data と _raw のマーカー不整合", () => {
		test("reconcileRaw: _data にマーカーがあり _raw に無い場合、_raw を再生成してマーカーを反映する", () => {
			const parsed = FrontMatter.parse('---\ntitle: "見出し"\n---\n');
			const fm = parsed.frontMatter;
			assert.ok(fm, "frontMatter が生成されていない");
			// _raw を介さず _data だけにマーカーが入った状態を再現する
			(fm as unknown as { _data: Record<string, unknown> })._data.mdait = { front: "abc12345" };
			assert.ok(!fm.raw.includes("mdait"), "前提: この時点で _raw にマーカーは無い");

			fm.reconcileRaw();
			assert.ok(fm.raw.includes("front: abc12345"), "reconcileRaw 後も _raw にマーカーが出ない");
		});

		test("reconcileRaw: _data と _raw が整合していれば非mdaitキーのフォーマットを変更しない（no-op）", () => {
			// 空行を含む non-mdait フォーマットを保持することを保証する（過剰な再フォーマット防止）
			const raw = '---\ntitle: テスト\nauthor: 太郎\n\n\nmdait:\n  front: deadbeef\n---';
			const parsed = FrontMatter.parse(`${raw}\n# body\n`);
			const fm = parsed.frontMatter;
			assert.ok(fm);
			const before = fm.raw;
			fm.reconcileRaw();
			assert.strictEqual(fm.raw, before, "整合済みなのに _raw が再生成された");
		});
	});

	suite("frontmatter + 本文 + マーカーの stringify 冪等性", () => {
		test("本文ありファイルでも stringify を繰り返して安定する", () => {
			const md = '---\ntitle: "タイトル"\nmdait:\n  front: 12345678\n---\n<!-- mdait 6647337d -->\n# 見出し\n\n本文。\n';
			const out1 = markdownParser.stringify(markdownParser.parse(md, makeConfig(2)));
			const out2 = markdownParser.stringify(markdownParser.parse(out1, makeConfig(2)));
			assert.strictEqual(out1, out2, "本文ありファイルで非冪等");
		});
	});
});
