import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../config/configuration";
import { Logger, formatError } from "../logging/logger";

/**
 * .mdaitディレクトリを初期化する
 * ディレクトリが存在しない場合は作成し、.gitignore・.gitattributes も自動生成する
 * 既に存在する場合でもこれらが無ければ追加する（冪等性を保証）
 *
 * @returns .mdaitディレクトリの絶対パス。ワークスペースが見つからない場合はnull
 */
export async function ensureMdaitDir(): Promise<string | null> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return null;
	}

	const mdaitDir = Configuration.getInstance().getMdaitDir();
	const gitignorePath = path.join(mdaitDir, ".gitignore");
	const gitattributesPath = path.join(mdaitDir, ".gitattributes");

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

		// .gitattributesが存在しない場合のみ作成
		// unit-state は全ファイルの状態を集約する単一TSV。external で並行翻訳すると
		// 1ファイルへ全員が書き込むため、union merge で別ファイル/別ユニットの編集を
		// 自動マージし、競合を最小化する（重複は次sync の load で Map デデュープ、save で正準化）。
		if (!fs.existsSync(gitattributesPath)) {
			const gitattributesContent = "unit-state merge=union\n";
			fs.writeFileSync(gitattributesPath, gitattributesContent, "utf-8");
		}
	} catch (error) {
		// .gitignore/.gitattributes 作成失敗はベストエフォートなので警告のみ
		Logger.getInstance().warn("mdait-dir", "failed to create .mdait/.gitignore or .gitattributes", formatError(error));
	}

	return mdaitDir;
}
