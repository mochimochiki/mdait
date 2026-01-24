// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { StatusCollector } from "../../../core/status/status-collector";
import { Status } from "../../../core/status/status-item";

suite("StatusCollector frontmatter-only判定", () => {
	let workspaceRoot: string;
	let tempDir: string;
	let filePath: string;

	setup(() => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error("ワークスペースが開かれていません");
		}
		workspaceRoot = folders[0].uri.fsPath;
		tempDir = path.join(workspaceRoot, ".mdait-test-status");
		filePath = path.join(tempDir, "frontmatter-only.md");

		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}

		const content = `---
title: "Hello"
mdait.front: "abc12345"
---
`;
		fs.writeFileSync(filePath, content, "utf8");
	});

	teardown(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("frontmatterのみのソースファイルはStatus.Sourceになること", async () => {
		const collector = new StatusCollector();
		const result = await collector.collectFileStatus(filePath);

		assert.strictEqual(result.status, Status.Source);
		assert.strictEqual(result.frontmatter?.status, Status.Source);
	});
});
