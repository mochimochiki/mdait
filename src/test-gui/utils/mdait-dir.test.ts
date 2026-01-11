/**
 * @file mdait-dir.test.ts
 * @description .mdaitディレクトリ初期化機能のテスト
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, suite, test } from "mocha";
import { ensureMdaitDir } from "../../utils/mdait-dir";

suite("ensureMdaitDir", () => {
	let workspaceRoot: string;
	let mdaitDir: string;
	let gitignorePath: string;

	beforeEach(() => {
		// テスト用ワークスペースのパスを取得
		workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
		mdaitDir = path.join(workspaceRoot, ".mdait");
		gitignorePath = path.join(mdaitDir, ".gitignore");

		// 既存の.mdaitディレクトリを削除してクリーンな状態にする
		if (fs.existsSync(mdaitDir)) {
			fs.rmSync(mdaitDir, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		// テスト後のクリーンアップ
		if (fs.existsSync(mdaitDir)) {
			fs.rmSync(mdaitDir, { recursive: true, force: true });
		}
	});

	test(".mdaitディレクトリが存在しない場合、新規作成される", async () => {
		assert.strictEqual(fs.existsSync(mdaitDir), false, ".mdaitディレクトリが事前に存在していない");

		const result = await ensureMdaitDir();

		assert.strictEqual(result, mdaitDir, "正しいパスが返される");
		assert.strictEqual(fs.existsSync(mdaitDir), true, ".mdaitディレクトリが作成される");
	});

	test(".gitignoreが自動生成される", async () => {
		await ensureMdaitDir();

		assert.strictEqual(fs.existsSync(gitignorePath), true, ".gitignoreが作成される");

		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.strictEqual(content, "logs/\n", ".gitignoreの内容が正しい");
	});

	test(".mdaitディレクトリが既に存在する場合、冪等性が保証される", async () => {
		// 初回実行
		await ensureMdaitDir();
		const firstContent = fs.readFileSync(gitignorePath, "utf-8");

		// 2回目実行
		await ensureMdaitDir();
		const secondContent = fs.readFileSync(gitignorePath, "utf-8");

		assert.strictEqual(firstContent, secondContent, "複数回実行しても内容が変わらない");
	});

	test(".mdaitディレクトリが存在し、.gitignoreが無い場合は追加される", async () => {
		// .mdaitディレクトリのみ作成
		fs.mkdirSync(mdaitDir, { recursive: true });
		assert.strictEqual(fs.existsSync(gitignorePath), false, ".gitignoreは存在しない");

		await ensureMdaitDir();

		assert.strictEqual(fs.existsSync(gitignorePath), true, ".gitignoreが追加される");
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.strictEqual(content, "logs/\n", ".gitignoreの内容が正しい");
	});

	test(".mdaitディレクトリと.gitignoreが既に存在する場合、上書きされない", async () => {
		// .mdaitディレクトリと.gitignoreを事前に作成
		fs.mkdirSync(mdaitDir, { recursive: true });
		const customContent = "logs/\ncustom-ignore/\n";
		fs.writeFileSync(gitignorePath, customContent, "utf-8");

		await ensureMdaitDir();

		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.strictEqual(content, customContent, "既存の.gitignoreは上書きされない");
	});
});
