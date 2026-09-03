/**
 * @file review-targets.ts
 * @description
 *   レビュー対象のターゲットMDファイル解決を担う共有ヘルパー。
 *   mdait_aiReview（スコープ指定あり）と mdait_adopt（ワークスペース全体）が共有する。
 * @module commands/ai-review/review-targets
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import type { FileExplorer } from "../../infra/workspace/file-explorer";

/**
 * ディレクトリ配下のターゲットMDファイルを列挙する。
 */
async function collectFromDir(
	dir: string,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<string[]> {
	const pattern = new vscode.RelativePattern(dir, "**/*.md");
	const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
	return found.map((f) => f.fsPath).filter((f) => fileExplorer.isTargetFile(f, config));
}

/**
 * 全 transPair のターゲットディレクトリ配下のターゲットMDファイルを重複なく列挙する。
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
 * レビュー対象のターゲットMDファイル群を解決する。
 * - path省略: 全transPairのターゲットディレクトリ配下
 * - pathがファイル: そのファイル（ターゲットであること）
 * - pathがディレクトリ: 配下のターゲットMDファイル
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
