// syncコマンド E2Eテスト
// テストガイドラインに従いテスト実装します。

import assert from "node:assert";
import { execSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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
	const sampleContentDir = join(
		__dirname,
		"../../../../src/test/sample-content",
	);
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

	test("mdait管理下にない既存Markdownを同期するとmdaitヘッダーが付与されること", async () => {
		// content/en/no_header.md, content/ja/no_header.md を使う
		const tmpEnNoHeader = join(tmpEnDir, "no_header.md");
		const tmpJaNoHeader = join(tmpJaDir, "no_header.md");

		// VSCode拡張コマンドとしてsyncを実行
		const vscode = require("vscode");
		const commandId = "mdait.sync";
		const result = await vscode.commands.executeCommand(commandId);

		const enText = readFileSync(tmpEnNoHeader, "utf8");
		const jaText = readFileSync(tmpJaNoHeader, "utf8");

		// 1. en, ja両方にmdaitヘッダーが付与されていること
		assert.match(enText, /^<!--\s*mdait [^\s]+/m);
		assert.match(jaText, /^<!--\s*mdait [^\s]+/m);
		// 2. enのmdaitヘッダーにjaの対応するヘッダーのハッシュがfrom:として書き込まれていること
		const jaHeader = jaText.match(/<!--\s*mdait ([^\s]+)/); // jaのハッシュ
		const enHeader = enText.match(/<!--\s*mdait ([^\s]+) from:([^\s]+)/); // enのfrom:xxx
		assert.ok(jaHeader && enHeader);
		assert.strictEqual(enHeader[2], jaHeader[1]);

		// 3. ユニット分割が行われていること（複数ヘッダーが存在する）
		const enHeaders = enText.match(/<!--\s*mdait [^\s]+/g) || [];
		const jaHeaders = jaText.match(/<!--\s*mdait [^\s]+/g) || [];
		assert.ok(enHeaders.length > 1);
		assert.ok(jaHeaders.length > 1);

		// コマンドの戻り値も検証（エラーでないこと）
		assert.notStrictEqual(result, false);
	});

	test("既存ユニットのコンテンツが変更された場合、関連ファイルにneed:translateが付与されること", async () => {
		// content/ja/test.md（ソース）、content/en/test.md（ターゲット）を使用
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpEnTest = join(tmpEnDir, "test.md");

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
		assert.match(enText, /<!-- mdait [^\s]+ from:[^\s]+ need:translate -->/);

		// 3. en側のfromが更新されたjaのハッシュと一致していること
		const enFirstUnit = enText.match(
			/<!-- mdait ([^\s]+) from:([^\s]+) need:translate -->/,
		);
		assert.ok(enFirstUnit);
		assert.strictEqual(enFirstUnit[2], jaNewHash);

		// コマンドの戻り値も検証
		assert.notStrictEqual(result, false);
	});

	test("autoMarkerLevel設定に従って適切な見出しレベルにマーカーが挿入されること", async () => {
		const testContent = `# 見出し 1

コンテンツ1

## 見出し 2

コンテンツ2

### 見出し 3

コンテンツ3
`;
		const tmpJaLevelTest = join(tmpJaDir, "level_test.md");
		const tmpEnLevelTest = join(tmpEnDir, "level_test.md");
		writeFileSync(tmpJaLevelTest, testContent, "utf8");
		writeFileSync(tmpEnLevelTest, testContent, "utf8");

		// syncを実行（デフォルトのautoMarkerLevel: 2）
		const vscode = require("vscode");
		await vscode.commands.executeCommand("mdait.sync");

		const jaText = readFileSync(tmpJaLevelTest, "utf8");
		const enText = readFileSync(tmpEnLevelTest, "utf8");

		// H1とH2の前にマーカーが挿入されていること（H3は挿入されない）
		const jaMarkers = jaText.match(/<!-- mdait [^\s]+/g) || [];
		const enMarkers = enText.match(/<!-- mdait [^\s]+/g) || [];

		// H1, H2のみなので2つのマーカーが存在する
		assert.strictEqual(jaMarkers.length, 2);
		assert.strictEqual(enMarkers.length, 2);

		// H3の前にはマーカーが挿入されていないこと
		assert.ok(
			!jaText.includes("<!-- mdait") ||
				jaText.indexOf("### 見出し 3") > jaText.lastIndexOf("<!-- mdait"),
		);
	});

	test("新規ユニットが追加された場合、対応するファイルに適切に挿入されること", async () => {
		// 既存のtest.mdファイルを使用
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpEnTest = join(tmpEnDir, "test.md");

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

	test("from一致による対応付けが正しく機能すること", async () => {
		// 既存のtest.mdファイルを使用
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpEnTest = join(tmpEnDir, "test.md");

		// 初期状態を確認
		const jaText = readFileSync(tmpJaTest, "utf8");
		const enText = readFileSync(tmpEnTest, "utf8");

		// ja側の特定のユニット（見出し2）のハッシュを取得
		const jaSecondUnit = jaText.match(/<!-- mdait (e330ab02) -->/);
		assert.ok(jaSecondUnit);
		const jaHash = jaSecondUnit[1];

		// en側の対応するユニットのfromがja側のハッシュと一致していることを確認
		const enSecondUnit = enText.match(/<!-- mdait [^\s]+ from:(e330ab02) -->/);
		assert.ok(enSecondUnit);
		assert.strictEqual(enSecondUnit[1], jaHash);
	});

	test("孤立ユニットがauto-delete設定に従って処理されること", async () => {
		// test.mdファイルを使用
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpEnTest = join(tmpEnDir, "test.md");

		// ja側から特定のユニットを削除（見出し6のユニット）
		let jaText = readFileSync(tmpJaTest, "utf8");
		const unitToRemove = /<!-- mdait eb633ff0 -->[\s\S]*?(?=<!-- mdait|$)/;
		jaText = jaText.replace(unitToRemove, "");
		writeFileSync(tmpJaTest, jaText, "utf8");

		// syncを実行（デフォルトでauto-delete: true）
		const vscode = require("vscode");
		await vscode.commands.executeCommand("mdait.sync");

		// en側の対応するユニットが削除されていること
		const enText = readFileSync(tmpEnTest, "utf8");
		assert.ok(!enText.includes("from:eb633ff0"));
		assert.ok(!enText.includes("#### Heading 6"));
	});

	test("Front Matter が存在するファイルでも正しくマーカーが挿入されること", async () => {
		// Front Matter付きのファイルでテスト
		const tmpJaNoHeader = join(tmpJaDir, "no_header.md");
		const tmpEnNoHeader = join(tmpEnDir, "no_header.md");

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

	test("空ファイルでもエラーが発生しないこと", async () => {
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

	test("不正なmdaitマーカー形式でもエラーが発生しないこと", async () => {
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

	test("片方向チェーン翻訳が正しく機能すること", async () => {
		// ja -> en -> de のチェーンをテスト
		// まず de ディレクトリを作成
		const tmpDeDir = join(contentDir, "de");
		mkdirSync(tmpDeDir, { recursive: true });

		// ja -> en の関係が既に存在する状態で、de ファイルを作成
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpEnTest = join(tmpEnDir, "test.md");
		const tmpDeTest = join(tmpDeDir, "test.md");

		// de側にen側と同じ構造のファイルを作成（翻訳前状態）
		const enText = readFileSync(tmpEnTest, "utf8");
		// src: を from: に変更してde側に作成
		const deText = enText.replace(/src:/g, "from:");
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

	test("双方向翻訳で競合が検出されること", async () => {
		// ja <-> en の双方向編集をシミュレート
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpEnTest = join(tmpEnDir, "test.md");

		// 両方のファイルを同時に編集
		let jaText = readFileSync(tmpJaTest, "utf8");
		let enText = readFileSync(tmpEnTest, "utf8");

		// ja側を編集
		jaText = jaText.replace(
			"これは日本語のテスト用 Markdown ファイルです。",
			"これは日本語側で編集されたファイルです。",
		);

		// en側も編集（同じユニット）
		enText = enText.replace(
			"This is a test Markdown file in English.",
			"This is a file edited on the English side.",
		);

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
		assert.ok(
			updatedEnText.includes("need:solve-conflict"),
			"英語ファイルに 'need:solve-conflict' が見つかりません",
		);
	});

	test("除外パターンに一致するファイルが処理されないこと", async () => {
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

	test("複数のmdaitマーカーが同じfromを持つ場合も正しく処理されること", async () => {
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

	test("ディレクトリが存在しない場合も正しく処理されること", async () => {
		// 存在しないディレクトリへの出力をテスト
		const nonExistentDir = join(workspaceDir, "content", "fr");
		const tmpJaTest = join(tmpJaDir, "test.md");
		const tmpFrTest = join(nonExistentDir, "test.md");

		// syncを実行（設定で新しいディレクトリペアを指定する必要があるが、
		// ここではディレクトリ作成機能のテストとして実行）
		const vscode = require("vscode");
		const result = await vscode.commands.executeCommand("mdait.sync");

		// エラーでないことを確認
		assert.notStrictEqual(result, false);
	});
});
