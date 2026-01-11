import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * .mdaitディレクトリを初期化する
 * ディレクトリが存在しない場合は作成し、.gitignoreも自動生成する
 * 既に存在する場合でも.gitignoreがなければ追加する（冪等性を保証）
 *
 * @returns .mdaitディレクトリの絶対パス。ワークスペースが見つからない場合はnull
 */
export async function ensureMdaitDir(): Promise<string | null> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return null;
	}

	const mdaitDir = path.join(workspaceRoot, ".mdait");
	const gitignorePath = path.join(mdaitDir, ".gitignore");

	try {
		// .mdaitディレクトリを作成（既に存在する場合は何もしない）
		if (!fs.existsSync(mdaitDir)) {
			fs.mkdirSync(mdaitDir, { recursive: true });
		}

		// .gitignoreが存在しない場合のみ作成
		if (!fs.existsSync(gitignorePath)) {
			const gitignoreContent = "logs/\n";
			fs.writeFileSync(gitignorePath, gitignoreContent, "utf-8");
		}
	} catch (error) {
		// .gitignore作成失敗はベストエフォートなので警告のみ
		console.warn("Failed to create .mdait/.gitignore:", error);
	}

	return mdaitDir;
}
