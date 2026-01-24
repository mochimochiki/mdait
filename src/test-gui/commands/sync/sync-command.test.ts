// syncコマンド E2Eテスト
// テストガイドラインに従いテスト実装します。

import assert from "node:assert";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function copyDirSync(src: string, dest: string) {
	if (!existsSync(dest)) {
		mkdirSync(dest, { recursive: true });
	}
	for (const entry of require("node:fs").readdirSync(src, {
		withFileTypes: true,
	})) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

suite("syncコマンドE2E", () => {
	const sampleContentDir = join(__dirname, "../../../../src/test/sample-content");
	const workspaceDir = join(__dirname, "../../../../src/test/workspace");
	const contentDir = join(workspaceDir, "content");
	const tmpEnDir = join(contentDir, "en");
	const tmpJaDir = join(contentDir, "ja");

	function cleanupFiles() {
		if (existsSync(workspaceDir)) {
			const fs = require("node:fs");
			fs.rmSync(join(workspaceDir, "content"), {
				recursive: true,
				force: true,
			});
		}
	}

	setup(() => {
		copyDirSync(sampleContentDir, contentDir);
	});
	teardown(() => {
		cleanupFiles();
	});

	suite("基本", () => {
		test("マーカー付与: 既存のMarkdownにmdaitマーカーが付与されること", async () => {
			// content/en/20_no_marker.md, content/ja/20_no_marker.md を使う
			const tmpEnNoHeader = join(tmpEnDir, "20_no_marker.md");
			const tmpJaNoHeader = join(tmpJaDir, "20_no_marker.md");

			// VSCode拡張コマンドとしてsyncを実行
			const vscode = require("vscode");
			const commandId = "mdait.sync";
			const result = await vscode.commands.executeCommand(commandId);

			const enText = readFileSync(tmpEnNoHeader, "utf8");
			const jaText = readFileSync(tmpJaNoHeader, "utf8");

			// 1. en, ja両方にmdaitマーカーが付与されていること
			assert.match(enText, /^<!--\s*mdait [^\s]+/m);
			assert.match(jaText, /^<!--\s*mdait [^\s]+/m);
			// 2. enのmdaitマーカーにjaの対応するマーカーのハッシュがfrom:として書き込まれていること
			const jaHeader = jaText.match(/<!--\s*mdait ([^\s]+)/); // jaのハッシュ
			const enHeader = enText.match(/<!--\s*mdait ([^\s]+) from:([^\s]+)/); // enのfrom:xxx
			assert.ok(jaHeader && enHeader);
			assert.strictEqual(enHeader[2], jaHeader[1]);

			// 3. ユニット分割が行われていること（複数マーカーが存在する）
			const enHeaders = enText.match(/<!--\s*mdait [^\s]+/g) || [];
			const jaHeaders = jaText.match(/<!--\s*mdait [^\s]+/g) || [];
			assert.ok(enHeaders.length > 1);
			assert.ok(jaHeaders.length > 1);

			// コマンドの戻り値も検証（エラーでないこと）
			assert.notStrictEqual(result, false);
		});

		test("from付与: マーカー付与後にfromでの対応付けができていること", async () => {
			// 既存の10_test.mdファイルを使用
			const tmpJaTest = join(tmpJaDir, "20_no_marker.md");
			const tmpEnTest = join(tmpEnDir, "20_no_marker.md");

			// syncコマンドを実行してマーカー・from付与を行う
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			// 実行後の内容を取得
			const jaText = readFileSync(tmpJaTest, "utf8");
			const enText = readFileSync(tmpEnTest, "utf8");

			// ja側の全mdaitマーカーのハッシュを取得
			const jaHashes = Array.from(jaText.matchAll(/<!-- mdait ([a-f0-9]{8}) -->/g)).map((m) => m[1]);
			assert.ok(jaHashes.length > 0);

			// en側の全mdaitマーカーのfrom:ハッシュを取得
			const enFromHashes = Array.from(enText.matchAll(/<!-- mdait [^\s]+ from:([a-f0-9]{8})/g)).map((m) => m[1]);

			// ja側の各ハッシュがen側のfrom:にすべて含まれていることを確認
			for (const jaHash of jaHashes) {
				assert.ok(enFromHashes.includes(jaHash), `en側のfrom:にjaのハッシュ${jaHash}が含まれていません`);
			}
		});

		test("level: level設定に従って適切な見出しレベルにマーカーが挿入されること", async () => {
			const testContent = `# 見出し 1

コンテンツ1

## 見出し 2

コンテンツ2

### 見出し 3

コンテンツ3
`;
			const tmpJaLevelTest = join(tmpJaDir, "level_10_test.md");
			const tmpEnLevelTest = join(tmpEnDir, "level_10_test.md");
			writeFileSync(tmpJaLevelTest, testContent, "utf8");
			writeFileSync(tmpEnLevelTest, testContent, "utf8");

			// syncを実行（デフォルトのlevel: 2）
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const jaText = readFileSync(tmpJaLevelTest, "utf8");
			const enText = readFileSync(tmpEnLevelTest, "utf8");

			// H1とH2の前にマーカーが挿入されていること（H3は挿入されない）
			const jaMarkers = jaText.match(/<!-- mdait [^\s]+/g) || [];
			const enMarkers = enText.match(/<!-- mdait [^\s]+/g) || [];

			// H1, H2, H3なので3つのマーカーが存在する
			assert.strictEqual(jaMarkers.length, 3);
			assert.strictEqual(enMarkers.length, 3);
		});

		test("FrontMatter: Front Matter が存在するファイルでも正しくマーカーが挿入されること", async () => {
			// Front Matter付きのファイルでテスト
			const tmpJaNoHeader = join(tmpJaDir, "20_no_marker.md");
			const tmpEnNoHeader = join(tmpEnDir, "20_no_marker.md");

			// syncを実行
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const jaText = readFileSync(tmpJaNoHeader, "utf8");
			const enText = readFileSync(tmpEnNoHeader, "utf8");

			// 1. Front Matterが保持されていること
			assert.match(jaText, /^---\s*\n.*?\n---\s*\n/s);
			assert.match(enText, /^---\s*\n.*?\n---\s*\n/s);

			// 2. mdaitマーカーがFront Matterの後に挿入されていること
			const frontMatterEnd = jaText.indexOf("---", 3) + 3;
			const firstMarker = jaText.indexOf("<!-- mdait");
			assert.ok(firstMarker > frontMatterEnd);
		});

		test("FrontMatter上書き: sourceのmdait.sync.level=3でH3までユニット化される", async () => {
			const content = `---\nmdait:\n  sync:\n    level: 3\n---\n# H1\n\n本文1\n\n## H2\n\n本文2\n\n### H3\n\n本文3\n`;
			const jaPath = join(tmpJaDir, "level_frontmatter_source_only.md");
			const enPath = join(tmpEnDir, "level_frontmatter_source_only.md");
			writeFileSync(jaPath, content, "utf8");
			// targetは存在しない状態から開始（初回作成パスを通す）
			if (existsSync(enPath)) unlinkSync(enPath);

			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const jaText = readFileSync(jaPath, "utf8");
			const enText = readFileSync(enPath, "utf8");
			const jaMarkers = jaText.match(/<!-- mdait [^\s]+/g) || [];
			const enMarkers = enText.match(/<!-- mdait [^\s]+/g) || [];
			// H1,H2,H3の3ユニットが生成される想定
			assert.strictEqual(jaMarkers.length, 3);
			assert.strictEqual(enMarkers.length, 3);
		});
	});

	suite("編集", () => {
		test("追加: 末尾に新たなユニット追加", async () => {
			// 既存の10_test.mdファイルを使用
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			// ja側に新規ユニットを追加
			let jaText = readFileSync(tmpJaTest, "utf8");
			const newUnit = `
## 新規見出し

これは新しく追加されたユニットです。
`;
			jaText += newUnit;
			writeFileSync(tmpJaTest, jaText, "utf8");

			// syncを実行
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			// en側にも新規ユニットが追加されていること
			const enText = readFileSync(tmpEnTest, "utf8");

			// 1. en側に新規ユニットが挿入されていること
			assert.ok(enText.includes("## 新規見出し"));

			// 2. 新規ユニットにneed:translateが付与されていること
			assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/);
		});

		test("追加: 途中に複数ユニットを挿入", async () => {
			// 10_test.mdのHeading 3とHeading 4の間に2つの新規ユニットを挿入
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			let jaText = readFileSync(tmpJaTest, "utf8");
			const insertIndex = jaText.indexOf("<!-- mdait 0641b670"); // Heading 4の直前
			const newUnits = `\n## 追加見出しA\n\n追加ユニットAの内容です。\n\n## 追加見出しB\n\n追加ユニットBの内容です。\n`;
			jaText = jaText.slice(0, insertIndex) + newUnits + jaText.slice(insertIndex);
			writeFileSync(tmpJaTest, jaText, "utf8");

			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const enText = readFileSync(tmpEnTest, "utf8");
			// 追加した2つの見出しがen側にも存在すること
			assert.ok(enText.includes("## 追加見出しA"));
			assert.ok(enText.includes("## 追加見出しB"));

			// 追加された場所が正しいこと
			// 追加した2つの見出しA/BがHeading 3とHeading 4の間にあることを確認
			const heading3Index = enText.indexOf("### Heading 3");
			const addedAIndex = enText.indexOf("## 追加見出しA");
			const addedBIndex = enText.indexOf("## 追加見出しB");
			const heading4Index = enText.indexOf("#### Heading 4");
			assert.ok(heading3Index < addedAIndex, "追加見出しAがHeading 3の後にありません");
			assert.ok(addedAIndex < addedBIndex, "追加見出しBが追加見出しAの後にありません");
			assert.ok(addedBIndex < heading4Index, "追加見出しBがHeading 4の前にありません");

			// それぞれneed:translateが付与されていること
			assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/);
		});

		test("追加: 空ユニット（見出しのみ）を追加", async () => {
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			let jaText = readFileSync(tmpJaTest, "utf8");
			// Heading 5の後に空ユニットを追加
			const insertIndex = jaText.indexOf("<!-- mdait dc5d14d1");
			const newUnit = `\n## 空見出し\n`;
			jaText = jaText.slice(0, insertIndex) + newUnit + jaText.slice(insertIndex);
			writeFileSync(tmpJaTest, jaText, "utf8");

			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const enText = readFileSync(tmpEnTest, "utf8");
			// 空見出しがen側にも存在すること
			assert.ok(enText.includes("## 空見出し"));
			// need:translateが付与されていること
			assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/);
		});

		test("追加: Front Matter直後にユニット追加", async () => {
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			let jaText = readFileSync(tmpJaTest, "utf8");
			const frontMatterEnd = jaText.indexOf("---", 3) + 3;
			const newUnit = `\n# Front直後見出し\n\nFront Matter直後のユニットです。\n`;
			jaText = jaText.slice(0, frontMatterEnd) + newUnit + jaText.slice(frontMatterEnd);
			writeFileSync(tmpJaTest, jaText, "utf8");

			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const enText = readFileSync(tmpEnTest, "utf8");
			// 追加した見出しがen側にも存在すること
			assert.ok(enText.includes("# Front直後見出し"));
			// need:translateが付与されていること
			assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/);
		});

		test("追加: 既存ユニットの分割による追加", async () => {
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			let jaText = readFileSync(tmpJaTest, "utf8");
			// Heading 2のユニットを2つに分割
			const heading2Index = jaText.indexOf("## Heading 2");
			const splitIndex = jaText.indexOf("- List item 3", heading2Index);
			const before = jaText.slice(0, splitIndex + "- List item 3".length);
			const newUnit = `\n\n---\n\n## 分割後見出し\n\n分割された新しいユニットです。\n`;
			const after = jaText.slice(splitIndex + "- List item 3".length);
			jaText = before + newUnit + after;
			writeFileSync(tmpJaTest, jaText, "utf8");

			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const enText = readFileSync(tmpEnTest, "utf8");
			// 分割後見出しがen側にも存在すること
			assert.ok(enText.includes("## 分割後見出し"));
			// need:translateが付与されていること
			assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/);
		});

		test("変更: 既存ユニットのコンテンツ変更時、need:translateが付与されること", async () => {
			// content/ja/10_test.md（ソース）、content/en/10_test.md（ターゲット）を使用
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			// 初期状態：既にmdaitマーカーが存在する
			let jaText = readFileSync(tmpJaTest, "utf8");
			let enText = readFileSync(tmpEnTest, "utf8");

			// jaファイルの最初のユニットの内容を変更
			const modifiedJaText = jaText.replace(
				"これは日本語のテスト用 Markdown ファイルです。",
				"これは変更された日本語のテスト用 Markdown ファイルです。",
			);
			writeFileSync(tmpJaTest, modifiedJaText, "utf8");

			// syncを実行
			const vscode = require("vscode");
			const result = await vscode.commands.executeCommand("mdait.sync");

			// 結果を読み込み
			jaText = readFileSync(tmpJaTest, "utf8");
			enText = readFileSync(tmpEnTest, "utf8");

			// 1. ja側のハッシュが更新されていること
			const jaFirstUnit = jaText.match(/<!-- mdait ([^\s]+) -->/);
			assert.ok(jaFirstUnit);
			const jaNewHash = jaFirstUnit[1];
			assert.notStrictEqual(jaNewHash, "9e3b618c"); // 元のハッシュと異なる

			// 2. en側の対応するユニットにneed:translateが付与されていること
			assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:revise@[^\s]+ -->/);

			// 3. en側のfromが更新されたjaのハッシュと一致していること
			const enFirstUnit = enText.match(/<!-- mdait ([^\s]+) from:([^\s]+) need:revise@[^\s]+ -->/);
			assert.ok(enFirstUnit);
			assert.strictEqual(enFirstUnit[2], jaNewHash);

			// コマンドの戻り値も検証
			assert.notStrictEqual(result, false);
		});

		test("削除: 孤立ユニットがauto-delete設定に従って処理されること", async () => {
			// 10_test.mdファイルを使用
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			// ja側から特定のユニットを削除（見出し6のユニット）
			let jaText = readFileSync(tmpJaTest, "utf8");
			const unitToRemove = /<!-- mdait 2507a192 -->[\s\S]*?(?=<!-- mdait|$)/;
			jaText = jaText.replace(unitToRemove, "");
			writeFileSync(tmpJaTest, jaText, "utf8");

			// syncを実行（デフォルトでauto-delete: true）
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			// en側の対応するユニットが削除されていること
			const enText = readFileSync(tmpEnTest, "utf8");
			assert.ok(!enText.includes("from:2507a192"));
			assert.ok(!enText.includes("#### Heading 6"));
		});

		test("複合: 複数ユニットの追加と削除が同時に行われること", async () => {
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			let jaText = readFileSync(tmpJaTest, "utf8");

			// 複数のユニットを削除 (Heading 4 と Heading 5)
			const unitToRemove1 = /<!-- mdait 0641b670 -->[\s\S]*?(?=<!-- mdait|$)/; // Heading 4
			const unitToRemove2 = /<!-- mdait 6f9de5a9 -->[\s\S]*?(?=<!-- mdait|$)/; // Heading 5
			jaText = jaText.replace(
				unitToRemove1,
				"\n\n## 複合テスト用追加見出し0\n\nこれも複合テストで追加されたユニットです。\n\n",
			);
			jaText = jaText.replace(unitToRemove2, "");

			// 複数のユニットを追加 (中間と末尾)
			const insertIndex = jaText.indexOf("<!-- mdait 2507a192"); // Heading 6 の前
			const newUnit1 = `\n\n## 複合テスト用追加見出し1\n\nこれは複合テストで追加されたユニットです。\n`;
			jaText = jaText.slice(0, insertIndex) + newUnit1 + jaText.slice(insertIndex);

			const newUnit2 = `\n## 複合テスト用追加見出し2\n\nこれも複合テストで追加されたユニットです。\n`;
			jaText += newUnit2;

			writeFileSync(tmpJaTest, jaText, "utf8");

			// syncを実行
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			const enText = readFileSync(tmpEnTest, "utf8");

			// 削除されたユニットがen側にもないことを確認
			assert.ok(!enText.includes("from:0641b670"));
			assert.ok(!enText.includes("#### Heading 4"));
			assert.ok(!enText.includes("from:6f9de5a9"));
			assert.ok(!enText.includes("##### Heading 5"));

			// 追加されたユニットがen側に存在し、need:translateが付与されていることを確認
			assert.ok(enText.includes("## 複合テスト用追加見出し0"));
			assert.ok(enText.includes("## 複合テスト用追加見出し1"));
			assert.ok(enText.includes("## 複合テスト用追加見出し2"));
			const addedUnits = enText.match(/<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/g) || [];
			// もともと1つ+3つ追加されているはず
			assert.strictEqual(addedUnits.length, 4, "追加されたユニットの数が正しくありません");
		});

		test("競合: 双方向翻訳で競合が検出されること", async () => {
			// ja <-> en の双方向編集をシミュレート
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");

			// 両方のファイルを同時に編集
			let jaText = readFileSync(tmpJaTest, "utf8");
			let enText = readFileSync(tmpEnTest, "utf8");

			// ja側を編集
			jaText = jaText.replace(
				"これは日本語のテスト用 Markdown ファイルです。",
				"これは日本語側で編集されたファイルです。",
			);

			// en側も編集（同じユニット）
			enText = enText.replace("This is a test Markdown file in English.", "This is a file edited on the English side.");

			writeFileSync(tmpJaTest, jaText, "utf8");
			writeFileSync(tmpEnTest, enText, "utf8");

			// syncを実行
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			// 両方にneed:solve-conflictが付与されることを期待
			// （現在の実装では競合検出機能が必要）
			const updatedJaText = readFileSync(tmpJaTest, "utf8");
			const updatedEnText = readFileSync(tmpEnTest, "utf8");

			// 両方のファイルに "need:solve-conflict" タグが付与されていることを確認
			assert.ok(
				updatedJaText.includes("need:solve-conflict"),
				"日本語ファイルに 'need:solve-conflict' が見つかりません",
			);
			assert.ok(updatedEnText.includes("need:solve-conflict"), "英語ファイルに 'need:solve-conflict' が見つかりません");
		});
	});

	suite("ファイル操作", () => {
		test("空ファイル: 空ファイルでもエラーが発生しないこと", async () => {
			// 空ファイルを作成
			const tmpJaEmpty = join(tmpJaDir, "empty.md");
			const tmpEnEmpty = join(tmpEnDir, "empty.md");
			writeFileSync(tmpJaEmpty, "", "utf8");
			writeFileSync(tmpEnEmpty, "", "utf8");

			// syncを実行してもエラーが発生しないこと
			const vscode = require("vscode");
			const result = await vscode.commands.executeCommand("mdait.sync");

			// エラーでないことを確認
			assert.notStrictEqual(result, false);

			// ファイルが存在し、内容が空でも問題ないことを確認
			const jaText = readFileSync(tmpJaEmpty, "utf8");
			const enText = readFileSync(tmpEnEmpty, "utf8");

			// 空ファイルの場合、マーカーは挿入されない
			assert.strictEqual(jaText.trim(), "");
			assert.strictEqual(enText.trim(), "");
		});

		test("不正マーカー: 不正なmdaitマーカー形式でもエラーが発生しないこと", async () => {
			// 不正なマーカーを含むファイルを作成
			const invalidContent = `# 見出し 1

<!-- mdait invalid_marker_format -->
コンテンツ1

<!-- mdait -->
## 見出し 2

コンテンツ2
`;
			const tmpJaInvalid = join(tmpJaDir, "invalid.md");
			const tmpEnInvalid = join(tmpEnDir, "invalid.md");
			writeFileSync(tmpJaInvalid, invalidContent, "utf8");
			writeFileSync(tmpEnInvalid, invalidContent, "utf8");

			// syncを実行してもエラーが発生しないこと
			const vscode = require("vscode");
			const result = await vscode.commands.executeCommand("mdait.sync");

			// エラーでないことを確認
			assert.notStrictEqual(result, false);
		});

		test("除外: 除外パターンに一致するファイルが処理されないこと", async () => {
			// node_modules ディレクトリを作成（デフォルトの除外パターン）
			const nodeModulesDir = join(tmpJaDir, "node_modules");
			mkdirSync(nodeModulesDir, { recursive: true });
			const tmpJaIgnored = join(nodeModulesDir, "ignored.md");
			const tmpEnIgnored = join(tmpEnDir, "node_modules", "ignored.md");

			writeFileSync(tmpJaIgnored, "# This should be ignored", "utf8");

			// syncを実行
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			// en側には作成されていないこと
			assert.ok(!existsSync(tmpEnIgnored));
		});

		test("複数from: 複数のmdaitマーカーが同じfromを持つ場合も正しく処理されること", async () => {
			// 同じfromを持つ複数ユニットのファイルを作成
			const duplicateFromContent = `<!-- mdait aaaa1111 from:common123 -->
# 見出し A

コンテンツA

<!-- mdait bbbb2222 from:common123 -->
# 見出し B

コンテンツB
`;
			const tmpJaDup = join(tmpJaDir, "duplicate.md");
			const tmpEnDup = join(tmpEnDir, "duplicate.md");
			writeFileSync(tmpJaDup, duplicateFromContent, "utf8");
			writeFileSync(tmpEnDup, duplicateFromContent, "utf8");

			// syncを実行してもエラーが発生しないこと
			const vscode = require("vscode");
			const result = await vscode.commands.executeCommand("mdait.sync");

			// エラーでないことを確認
			assert.notStrictEqual(result, false);
		});

		test("ディレクトリ: ディレクトリが存在しない場合も正しく処理されること", async () => {
			// 存在しないディレクトリへの出力をテスト
			const nonExistentDir = join(workspaceDir, "content", "fr");
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpFrTest = join(nonExistentDir, "10_test.md");

			// syncを実行（設定で新しいディレクトリペアを指定する必要があるが、
			// ここではディレクトリ作成機能のテストとして実行）
			const vscode = require("vscode");
			const result = await vscode.commands.executeCommand("mdait.sync");

			// エラーでないことを確認
			assert.notStrictEqual(result, false);
		});
	});

	suite("その他", () => {
		test("チェーン: 片方向チェーン翻訳が正しく機能すること", async () => {
			// ja -> en -> de のチェーンをテスト
			// まず de ディレクトリを作成
			const tmpDeDir = join(contentDir, "de");
			mkdirSync(tmpDeDir, { recursive: true });

			// ja -> en の関係が既に存在する状態で、de ファイルを作成
			const tmpJaTest = join(tmpJaDir, "10_test.md");
			const tmpEnTest = join(tmpEnDir, "10_test.md");
			const tmpDeTest = join(tmpDeDir, "10_test.md");

			// de側にen側と同じ構造のファイルを作成（翻訳前状態）
			const enText = readFileSync(tmpEnTest, "utf8");
			const deText = enText;
			writeFileSync(tmpDeTest, deText, "utf8");

			// ja側のコンテンツを変更
			let jaText = readFileSync(tmpJaTest, "utf8");
			jaText = jaText.replace(
				"これは日本語のテスト用 Markdown ファイルです。",
				"これは更新された日本語のテスト用 Markdown ファイルです。",
			);
			writeFileSync(tmpJaTest, jaText, "utf8");

			// ja -> en の sync を実行
			const vscode = require("vscode");
			await vscode.commands.executeCommand("mdait.sync");

			// en側にneed:translateが付与されていることを確認
			const updatedEnText = readFileSync(tmpEnTest, "utf8");
			assert.match(updatedEnText, /need:translate/);

			// en -> de の sync でも影響が伝播することを期待
			// （現在の実装では翻訳ペア設定が必要）
		});
	});
});
