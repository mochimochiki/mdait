/**
 * @file mdait-dir.test.ts
 * @description .mdaitディレクトリ初期化機能のテスト
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import { ensureMdaitDir } from "../../utils/mdait-dir";
import { copyDirSync } from "../test-utils";

suite("ensureMdaitDir", () => {
	let workspaceRoot: string;
	let mdaitDir: string;
	let gitignorePath: string;
	let backupDir: string;

	// ディレクトリ削除のヘルパー関数（EBUSYエラーを無視）
	const safeRemoveDir = (dirPath: string) => {
		try {
			if (fs.existsSync(dirPath)) {
				fs.rmSync(dirPath, { recursive: true, force: true });
			}
		} catch (err) {
			// EBUSY等のエラーは無視（他のプロセスがロックしている可能性）
			console.log(`Warning: Could not remove ${dirPath}: ${err}`);
		}
	};

	suiteSetup(() => {
		workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
		mdaitDir = path.join(workspaceRoot, ".mdait");
		backupDir = path.join(workspaceRoot, ".mdait-backup-test");

		// .mdaitディレクトリをバックアップ
		safeRemoveDir(backupDir);
		if (fs.existsSync(mdaitDir)) {
			copyDirSync(mdaitDir, backupDir);
		}
	});

	suiteTeardown(() => {
		// バックアップから.mdaitを復元
		safeRemoveDir(mdaitDir);
		if (fs.existsSync(backupDir)) {
			copyDirSync(backupDir, mdaitDir);
			safeRemoveDir(backupDir);
		}
	});

	setup(() => {
		gitignorePath = path.join(mdaitDir, ".gitignore");

		// UnitRegistryManagerのキャッシュをリセット
		UnitRegistryManager.resetInstance();

		// 既存の.mdaitディレクトリを削除してクリーンな状態にする
		safeRemoveDir(mdaitDir);
	});

	teardown(() => {
		// テスト後のクリーンアップ（個別テスト間）
		safeRemoveDir(mdaitDir);
	});

	test(".mdaitディレクトリが存在しない場合、新規作成される", async function () {
		// ディレクトリが削除できなかった場合はスキップ
		if (fs.existsSync(mdaitDir)) {
			console.log("Skipping test: .mdait directory is locked by another process");
			this.skip();
			return;
		}

		const result = await ensureMdaitDir();

		assert.strictEqual(result, mdaitDir, "正しいパスが返される");
		assert.strictEqual(fs.existsSync(mdaitDir), true, ".mdaitディレクトリが作成される");
	});

	test(".gitignoreが自動生成される", async function () {
		// 事前に.mdaitディレクトリを削除してクリーンな状態にする
		safeRemoveDir(mdaitDir);

		// ディレクトリが削除できなかった場合はスキップ
		if (fs.existsSync(mdaitDir)) {
			console.log("Skipping test: .mdait directory is locked by another process");
			this.skip();
			return;
		}

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

	test(".mdaitディレクトリが存在し、.gitignoreが無い場合は追加される", async function () {
		// .mdaitディレクトリのみ作成（.gitignoreは削除）
		fs.mkdirSync(mdaitDir, { recursive: true });
		// .gitignoreが存在する場合は明示的に削除
		if (fs.existsSync(gitignorePath)) {
			try {
				fs.rmSync(gitignorePath, { force: true });
			} catch {
				// 削除できない場合はスキップ
				console.log("Skipping test: .gitignore is locked by another process");
				this.skip();
				return;
			}
		}
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
