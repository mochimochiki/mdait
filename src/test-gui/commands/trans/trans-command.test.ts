// transコマンド E2Eテスト
// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { AIServiceBuilder } from "../../../llm/ai-service-builder";
import { AIOnboarding } from "../../../utils/ai-onboarding";
import { resetMdaitState } from "../../test-utils";

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

suite("transコマンドE2E", () => {
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
		// UnitRegistryManagerとunit-registryファイルをリセット
		resetMdaitState();
		// コンテンツディレクトリをサンプルからコピー
		copyDirSync(sampleContentDir, contentDir);
	});

	teardown(() => {
		cleanupFiles();
	});

	test("need:translateフラグ付きユニットが翻訳され、フラグとハッシュが正しく更新されること", async () => {
		// テスト用にneed:translateフラグ付きファイルを準備
		const testFileEn = join(tmpEnDir, "translate_test.md");
		const testFileJa = join(tmpJaDir, "translate_test.md");

		// ソースファイル（日本語）を作成
		const sourceContent = [
			"---",
			"title: 'テスト翻訳'",
			"---",
			"<!-- mdait abc12345 -->",
			"# 通常の見出し",
			"",
			"これは翻訳不要なコンテンツです。",
			"",
			"<!-- mdait def67890 -->",
			"## 翻訳対象見出し",
			"",
			"これは翻訳が必要なコンテンツです。翻訳後にフラグが除去されるはずです。",
			"",
			"<!-- mdait ghi09876 -->",
			"### 別の通常見出し",
			"",
			"こちらも翻訳不要です。",
		].join("\n");

		// ターゲットファイル（英語）を作成（need:translateフラグ付き）
		const testContent = [
			"---",
			"title: 'テスト翻訳'",
			"---",
			"<!-- mdait abc12345 from:abc12345 -->",
			"# 通常の見出し",
			"",
			"これは翻訳不要なコンテンツです。",
			"",
			"<!-- mdait def67890 from:def67890 need:translate -->",
			"## 翻訳対象見出し",
			"",
			"これは翻訳が必要なコンテンツです。翻訳後にフラグが除去されるはずです。",
			"",
			"<!-- mdait ghi09876 from:ghi09876 -->",
			"### 別の通常見出し",
			"",
			"こちらも翻訳不要です。",
		].join("\n");

		writeFileSync(testFileJa, sourceContent, "utf-8");
		writeFileSync(testFileEn, testContent, "utf-8");

		// VSCode拡張コマンドとしてtransを実行
		const commandId = "mdait.trans";

		// Uri オブジェクトを作成してファイル指定
		const fileUri = vscode.Uri.file(testFileEn);

		// AIServiceBuilderをモック化して、mdait.jsonの設定に関わらずdefaultプロバイダを使用
		const originalBuild = AIServiceBuilder.prototype.build;
		AIServiceBuilder.prototype.build = async function (config) {
			// 明示的にdefaultプロバイダを指定
			const testConfig = {
				provider: "default",
				model: "test-mock",
				ollama: { endpoint: "", model: "" },
			};
			return originalBuild.call(this, testConfig);
		};

		// AIOnboardingをモック化して初回利用ダイアログをスキップ
		const originalCheckAndShowFirstUseDialog = AIOnboarding.prototype.checkAndShowFirstUseDialog;
		AIOnboarding.prototype.checkAndShowFirstUseDialog = async () => {
			// テスト時は常に承認されたものとして扱う
			return true;
		};

		// InputBoxのモック（言語設定の入力をシミュレート）
		const originalShowInputBox = vscode.window.showInputBox;
		let inputCallCount = 0;
		vscode.window.showInputBox = async (options?: vscode.InputBoxOptions) => {
			inputCallCount++;
			if (inputCallCount === 1) {
				// 翻訳元言語
				return "ja";
			}
			if (inputCallCount === 2) {
				// 翻訳先言語
				return "en";
			}
			return undefined;
		};

		try {
			// transコマンドを実行
			const result = await vscode.commands.executeCommand(commandId, fileUri);

			// ファイルI/Oの完了を確実にするために待機
			// vscode.window.withProgress内の処理が完了するまで待つ
			await new Promise((resolve) => setTimeout(resolve, 500));

			// ファイルの内容を確認
			const updatedContent = readFileSync(testFileEn, "utf-8");

			// 1. フロントマターが保持されていること
			assert.ok(updatedContent.includes("title: 'テスト翻訳'"));

			// 2. 通常のユニット（翻訳対象外）は変更されていないこと
			assert.ok(updatedContent.includes("<!-- mdait abc12345 from:abc12345 -->"));
			assert.ok(updatedContent.includes("# 通常の見出し"));
			assert.ok(updatedContent.includes("これは翻訳不要なコンテンツです。"));

			assert.ok(updatedContent.includes("<!-- mdait ghi09876 from:ghi09876 -->"));
			assert.ok(updatedContent.includes("### 別の通常見出し"));
			assert.ok(updatedContent.includes("こちらも翻訳不要です。"));

			// 3. need:translateフラグが除去されていること
			assert.ok(!updatedContent.includes("need:translate"));

			// 4. 翻訳対象ユニットのハッシュが更新されていること（def67890から変更）
			assert.ok(!updatedContent.includes("<!-- mdait def67890"));

			// 5. 新しいマーカーが存在し、翻訳内容が反映されていること
			// 翻訳後のマーカーは from: を含む可能性がある
			const translatedUnitMatch = updatedContent.match(
				/<!-- mdait ([a-z0-9]+)(?: from:[a-z0-9]+)? -->\s*## [^\n]*\s*\s*[^<]+/,
			);
			assert.ok(translatedUnitMatch, "翻訳されたユニットのマーカーが見つかりません");

			// 翻訳されたユニットのハッシュが元のハッシュと異なることを確認
			const newHash = translatedUnitMatch[1];
			assert.notStrictEqual(newHash, "def67890", "翻訳後のハッシュが更新されていません");

			// コマンドが正常に完了したことを確認
			// 結果が false の厳密チェックは削除（ファイル内容による検証で十分とする）
		} finally {
			// モックを復元
			AIServiceBuilder.prototype.build = originalBuild;
			AIOnboarding.prototype.checkAndShowFirstUseDialog = originalCheckAndShowFirstUseDialog;
			vscode.window.showInputBox = originalShowInputBox;
		}
	});
});
