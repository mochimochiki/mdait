// 水平線（`---`）で始まる Markdown を「フロントマターだけの文書」と誤読しないことの回帰テスト。
//
// gray-matter は先頭の `---` を無条件にフロントマターの開始と見なすため、本文の水平線で
// 始まる文書では次の3通りに壊れていた。
//   1. 本文が YAML として解釈できず例外を投げる（sync が落ちる）
//   2. 本文が1つの YAML スカラーとして解釈され、data が文字列になったまま本文が消える
//      （ユニット0件は mdait の各所で「触らない」に吸い込まれるので、ユーザーには
//        「なぜかこの文書だけ翻訳されない」としか見えない）
//   3. 2の状態でマーカーを書こうとして TypeError になる
//
// 判別は「gray-matter の data がマッピング（プレーンオブジェクト）であること」で行う。
// **空のマッピング `{}` もフロントマターとして扱う**必要がある。空のフロントマターや
// コメントだけのフロントマターは data が `{}` になるが、gray-matter は既に区切りを
// content から取り除いているので、フロントマター無しと判定すると区切りごと消える。

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../../core/markdown/front-matter";

/** parse した結果を元の文字列に戻せる（1バイトも失われていない）ことを確かめる */
function assertRoundTrip(markdown: string, message: string): void {
	const parsed = FrontMatter.parse(markdown);
	const restored = (parsed.frontMatter?.stringify() ?? "") + parsed.content;
	assert.strictEqual(restored, markdown, message);
}

suite("FrontMatter.parse（水平線で始まる文書）", () => {
	test("本文が YAML として壊れる文書でも例外を投げず、フロントマター無しとして本文をそのまま返す", () => {
		const md = "---\n\n# Title\n\nbody\n\n## Sec\n\nmore\n";

		const parsed = FrontMatter.parse(md);

		assert.strictEqual(parsed.frontMatter, undefined, "水平線をフロントマターと誤読している");
		assert.strictEqual(parsed.content, md, "本文が失われている");
		assert.strictEqual(parsed.frontMatterLineOffset, 0);
	});

	test("本文が1つの YAML スカラーになる文書でも、本文を飲み込まずフロントマター無しとして返す", () => {
		const md = "---\n\n# Title\n\nbody text\n";

		const parsed = FrontMatter.parse(md);

		assert.strictEqual(parsed.frontMatter, undefined, "本文がフロントマターとして読み取られている");
		assert.strictEqual(parsed.content, md, "本文が失われている");
	});

	test("水平線が2つある文書でも、最初の区間を飲み込まずフロントマター無しとして返す", () => {
		const md = "---\n\ntext\n\n---\n\nmore\n";

		const parsed = FrontMatter.parse(md);

		assert.strictEqual(parsed.frontMatter, undefined, "水平線に挟まれた区間をフロントマターと誤読している");
		assert.strictEqual(parsed.content, md, "最初の区間が失われている");
	});

	test("本来のフロントマターは今までどおり読み取れる", () => {
		const md = "---\ntitle: x\ndescription: y\n---\n\n# T\n";

		const parsed = FrontMatter.parse(md);

		assert.ok(parsed.frontMatter, "フロントマターが読み取れていない");
		assert.strictEqual(parsed.frontMatter.get("title"), "x");
		assert.strictEqual(parsed.frontMatter.get("description"), "y");
		assert.strictEqual(parsed.content, "\n# T\n");
	});

	test("フロントマターだけの文書も今までどおりフロントマターとして読み取れる", () => {
		const md = "---\ntitle: x\n---\n";

		const parsed = FrontMatter.parse(md);

		assert.ok(parsed.frontMatter, "フロントマターが読み取れていない");
		assert.strictEqual(parsed.frontMatter.get("title"), "x");
	});

	test("そもそもフロントマターが無い文書はフロントマター無しとして返す", () => {
		const md = "# T\n\nbody\n";

		const parsed = FrontMatter.parse(md);

		assert.strictEqual(parsed.frontMatter, undefined);
		assert.strictEqual(parsed.content, md);
	});

	test("空のフロントマターはフロントマターとして扱い、区切りを消さない", () => {
		const md = "---\n---\n\n# T\n";

		const parsed = FrontMatter.parse(md);

		assert.ok(parsed.frontMatter, "空のフロントマターがフロントマター無しと判定されている");
		assert.match(parsed.frontMatter.raw, /^---\n---/, "区切りが失われている");
	});

	test("コメントだけのフロントマターもフロントマターとして扱い、区切りとコメントを消さない", () => {
		const md = "---\n# just a comment\n---\n\n# T\n";

		const parsed = FrontMatter.parse(md);

		assert.ok(parsed.frontMatter, "コメントだけのフロントマターがフロントマター無しと判定されている");
		assert.match(parsed.frontMatter.raw, /# just a comment/, "コメントが失われている");
	});

	test("フロントマター無しと判定した文書にマーカーを書いても型エラーにならない", () => {
		const md = "---\n\n# Title\n\nbody text\n";

		const parsed = FrontMatter.parse(md);

		// 誤読された場合は _data が文字列になり、ここで
		// TypeError: Cannot create property 'mdait' on string 'body text' になる
		const frontMatter = parsed.frontMatter ?? FrontMatter.empty();
		frontMatter.set("mdait.front", "deadbeef");
		assert.strictEqual(frontMatter.get("mdait.front"), "deadbeef");
	});
});

suite("FrontMatter.parse → stringify の往復（元のバイト列を保つ）", () => {
	test("水平線で始まり YAML として壊れる文書が1バイトも失われない", () => {
		assertRoundTrip("---\n\n# Title\n\nbody\n\n## Sec\n\nmore\n", "往復で内容が変わっている");
	});

	test("水平線で始まりスカラーとして読まれる文書が1バイトも失われない", () => {
		assertRoundTrip("---\n\n# Title\n\nbody text\n", "往復で内容が変わっている");
	});

	test("水平線が2つある文書が1バイトも失われない", () => {
		assertRoundTrip("---\n\ntext\n\n---\n\nmore\n", "往復で内容が変わっている");
	});

	test("空のフロントマターの区切りが往復で消えない", () => {
		assertRoundTrip("---\n---\n\n# T\n", "空のフロントマターの区切りが往復で消えている");
	});

	test("コメントだけのフロントマターが往復で消えない", () => {
		assertRoundTrip("---\n# just a comment\n---\n\n# T\n", "コメントだけのフロントマターが往復で消えている");
	});

	test("本来のフロントマターを持つ文書が往復で変わらない", () => {
		assertRoundTrip("---\ntitle: x\ndescription: y\n---\n\n# T\n", "往復で内容が変わっている");
	});

	test("フロントマターだけの文書が往復で変わらない", () => {
		assertRoundTrip("---\ntitle: x\n---\n", "往復で内容が変わっている");
	});

	test("フロントマターが無い文書が往復で変わらない", () => {
		assertRoundTrip("# T\n\nbody\n", "往復で内容が変わっている");
	});
});
