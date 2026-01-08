import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { PromptIds } from "../../prompts/defaults";
import { PromptProvider } from "../../prompts/prompt-provider";

suite("PromptProvider インストラクション機能のテスト", () => {
	let workspaceRoot: string;
	let mdaitDir: string;
	let instructionFilePath: string;

	setup(() => {
		// テスト用のワークスペースディレクトリを設定
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error("ワークスペースが開かれていません");
		}
		workspaceRoot = folders[0].uri.fsPath;
		mdaitDir = path.join(workspaceRoot, ".mdait");
		instructionFilePath = path.join(mdaitDir, "mdait-instruction.md");

		// .mdaitディレクトリを作成
		if (!fs.existsSync(mdaitDir)) {
			fs.mkdirSync(mdaitDir, { recursive: true });
		}

		// PromptProviderのキャッシュをクリア
		PromptProvider.getInstance().clearCache();
	});

	teardown(() => {
		// インストラクションファイルを削除
		if (fs.existsSync(instructionFilePath)) {
			fs.unlinkSync(instructionFilePath);
		}

		// PromptProviderのキャッシュをクリア
		PromptProvider.getInstance().clearCache();
	});

	test("インストラクションファイルが存在しない場合、プロンプトはそのまま返される", () => {
		const provider = PromptProvider.getInstance();
		const prompt = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});

		// インストラクションが含まれていないことを確認
		assert.ok(prompt.length > 0);
		assert.ok(!prompt.includes("背景知識"));
	});

	test("インストラクションファイルが存在する場合、内容がプロンプトに追加される", () => {
		// インストラクションファイルを作成
		const instructionContent = `---
---

このプロジェクトは技術ドキュメントです。
専門用語に注意して翻訳してください。`;

		fs.writeFileSync(instructionFilePath, instructionContent, "utf8");

		const provider = PromptProvider.getInstance();
		const prompt = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});

		// インストラクションが含まれていることを確認
		assert.ok(prompt.includes("このプロジェクトは技術ドキュメントです"));
		assert.ok(prompt.includes("専門用語に注意して翻訳してください"));
	});

	test("フロントマターでプロンプトIDを指定した場合、該当プロンプトにのみ適用される", () => {
		// trans.translateのみに適用するインストラクション
		const instructionContent = `---
prompts: ["trans.translate"]
---

翻訳専用の指示です。`;

		fs.writeFileSync(instructionFilePath, instructionContent, "utf8");

		const provider = PromptProvider.getInstance();

		// trans.translateには適用される
		const translatePrompt = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(translatePrompt.includes("翻訳専用の指示です"));

		// term.detectには適用されない
		const detectPrompt = provider.getPrompt(PromptIds.TERM_DETECT_SOURCE_ONLY, {
			lang: "ja",
		});
		assert.ok(!detectPrompt.includes("翻訳専用の指示です"));
	});

	test("フロントマターで複数のプロンプトIDを指定できる", () => {
		const instructionContent = `---
prompts: ["trans.translate", "term.translateTerms"]
---

翻訳関連の共通指示です。`;

		fs.writeFileSync(instructionFilePath, instructionContent, "utf8");

		const provider = PromptProvider.getInstance();

		// trans.translateに適用される
		const translatePrompt = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(translatePrompt.includes("翻訳関連の共通指示です"));

		// term.translateTermsに適用される
		const termTranslatePrompt = provider.getPrompt(PromptIds.TERM_TRANSLATE_TERMS, {
			sourceLang: "ja",
			targetLang: "en",
		});
		assert.ok(termTranslatePrompt.includes("翻訳関連の共通指示です"));

		// term.detectには適用されない
		const detectPrompt = provider.getPrompt(PromptIds.TERM_DETECT_SOURCE_ONLY, {
			lang: "ja",
		});
		assert.ok(!detectPrompt.includes("翻訳関連の共通指示です"));
	});

	test("フロントマターでプロンプトIDが指定されていない場合、全プロンプトに適用される", () => {
		const instructionContent = `---
---

全プロンプト共通の指示です。`;

		fs.writeFileSync(instructionFilePath, instructionContent, "utf8");

		const provider = PromptProvider.getInstance();

		// すべてのプロンプトに適用されることを確認
		const translatePrompt = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(translatePrompt.includes("全プロンプト共通の指示です"));

		const detectPrompt = provider.getPrompt(PromptIds.TERM_DETECT_SOURCE_ONLY, {
			lang: "ja",
		});
		assert.ok(detectPrompt.includes("全プロンプト共通の指示です"));
	});

	test("インストラクションの内容がキャッシュされる", () => {
		const instructionContent = `---
---

キャッシュテスト用の指示です。`;

		fs.writeFileSync(instructionFilePath, instructionContent, "utf8");

		const provider = PromptProvider.getInstance();

		// 1回目の読み込み
		const prompt1 = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(prompt1.includes("キャッシュテスト用の指示です"));

		// ファイルを削除してもキャッシュから読み込まれる
		fs.unlinkSync(instructionFilePath);

		// 2回目の読み込み（キャッシュから）
		const prompt2 = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(prompt2.includes("キャッシュテスト用の指示です"));
	});

	test("clearCache()でインストラクションのキャッシュがクリアされる", () => {
		const instructionContent = `---
---

キャッシュクリアテスト用の指示です。`;

		fs.writeFileSync(instructionFilePath, instructionContent, "utf8");

		const provider = PromptProvider.getInstance();

		// 1回目の読み込み
		const prompt1 = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(prompt1.includes("キャッシュクリアテスト用の指示です"));

		// ファイルを削除してキャッシュをクリア
		fs.unlinkSync(instructionFilePath);
		provider.clearCache();

		// 2回目の読み込み（ファイルが存在しないので指示は含まれない）
		const prompt2 = provider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "ja",
		});
		assert.ok(!prompt2.includes("キャッシュクリアテスト用の指示です"));
	});
});
