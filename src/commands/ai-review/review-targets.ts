/**
 * @file review-targets.ts
 * @description
 *   レビュー対象のターゲットファイル解決を担う共有ヘルパー。
 *   mdait_aiReview（スコープ指定あり）と mdait_adopt（ワークスペース全体）が共有する。
 * @module commands/ai-review/review-targets
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import { FileExplorer } from "../../infra/workspace/file-explorer";

/**
 * 原文のある訳文かどうか。
 *
 * 原文の無い訳文（孤立訳文）は、レビューが見ても「原文が見つからない」と失敗するしかない。
 * その事実は sync が孤立訳文の通知とツリーで既に伝えているので、レビューが同じことを
 * **エラーとして数え直す**と、取り込みの結果が理由の分からない「errors: 1」になる
 * （実測。原文に無い訳文を1本混ぜた見本サイトで、レビューの唯一のエラーがこれだった）。
 */
function hasSource(file: string, config: Configuration, fileExplorer: FileExplorer): boolean {
	const pair = fileExplorer.getTransPairFromTarget(file, config);
	if (!pair) return false;
	const sourceFile = fileExplorer.getSourcePath(file, pair);
	return !!sourceFile && fs.existsSync(sourceFile);
}

/**
 * ディレクトリ配下のターゲットファイルを列挙する。
 *
 * **Markdown だけでなく、管理下の非Markdown（`trans.extensions`）も対象にする。**
 * 非Markdown はファイル1本が1ユニットで、状態は `unit-state` の行に載る（`file-type.ts`）。
 * 翻訳はされるのにレビューだけ素通りしていたため、取り込みのあと**確認待ちが人手でしか
 * 外れなかった**（実測: 見本サイトの取り込みで .txt / .csv / .json の3本が残った）。
 *
 * 孤立訳文は外す。**名指しで渡されたときは外さない**（`resolveReviewTargets` の
 * ファイル指定）— そちらは利用者がそのファイルを指したのだから、黙って何もしないより
 * 「原文が見つからない」と言うほうが正しい。
 */
async function collectFromDir(
	dir: string,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<string[]> {
	const pattern = new vscode.RelativePattern(dir, FileExplorer.buildExtensionGlob(config.trans.extensions));
	const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
	return found
		.map((f) => f.fsPath)
		.filter((f) => fileExplorer.isTargetFile(f, config) && hasSource(f, config, fileExplorer));
}

/**
 * 全 transPair のターゲットディレクトリ配下のターゲットファイルを重複なく列挙する。
 */
export async function collectWorkspaceReviewTargets(
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<string[]> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const configBase = config.getConfigBaseDir() ?? workspaceRoot ?? "";
	const results: string[] = [];
	const seen = new Set<string>();
	for (const pair of config.transPairs) {
		const dir = path.isAbsolute(pair.targetDir) ? pair.targetDir : path.resolve(configBase, pair.targetDir);
		if (!fs.existsSync(dir)) {
			continue;
		}
		for (const file of await collectFromDir(dir, config, fileExplorer)) {
			if (!seen.has(file)) {
				seen.add(file);
				results.push(file);
			}
		}
	}
	return results;
}

/**
 * レビュー対象のターゲットファイル群を解決する。
 * - path省略: 全transPairのターゲットディレクトリ配下
 * - pathがファイル: そのファイル（ターゲットであること）
 * - pathがディレクトリ: 配下のターゲットファイル
 */
export async function resolveReviewTargets(
	inputPath: string | undefined,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<string[]> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	if (!inputPath) {
		return collectWorkspaceReviewTargets(config, fileExplorer);
	}

	const absPath = path.isAbsolute(inputPath)
		? inputPath
		: workspaceRoot
			? path.resolve(workspaceRoot, inputPath)
			: inputPath;
	if (!fs.existsSync(absPath)) {
		return [];
	}
	if (fs.statSync(absPath).isDirectory()) {
		return collectFromDir(absPath, config, fileExplorer);
	}
	return fileExplorer.isTargetFile(absPath, config) ? [absPath] : [];
}
