import * as path from "node:path";
import * as vscode from "vscode";

/**
 * 絶対パスをワークスペースルート相対パス（/区切り）に変換する。
 *
 * external マーカーの `UnitStateStore` キーや CodeLens の状態参照など、
 * 文書横断でファイルを同一視するためのキーとして使用する。
 * 区切り文字を `/` に統一するため、OS をまたいでも同一キーになる。
 *
 * @param absolutePath 変換する絶対パス
 * @throws ワークスペースフォルダが開かれていない場合
 */
export function toWorkspaceRelativePath(absolutePath: string): string {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		throw new Error("No workspace folder found");
	}
	return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}

/**
 * ワークスペースルート相対パス（/区切り）を絶対パスへ戻す。
 *
 * `UnitStateStore` の行が持つパスをディスク上の実体と突き合わせるために使う
 * （行の `path` はワークスペース相対なので、そのままでは `fs` に渡せない）。
 *
 * @param relativePath 変換する相対パス
 * @throws ワークスペースフォルダが開かれていない場合
 */
export function toAbsoluteWorkspacePath(relativePath: string): string {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		throw new Error("No workspace folder found");
	}
	return path.resolve(workspaceRoot, relativePath);
}
