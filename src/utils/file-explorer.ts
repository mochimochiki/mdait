import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../config/configuration";

/**
 * ファイル探索を行うクラス
 */
export class FileExplorer {
	/**
	 * ディレクトリが存在するか確認する
	 */
	public directoryExists(dirPath: string): boolean {
		try {
			return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
		} catch (error) {
			return false;
		}
	}

	/**
	 * ディレクトリ内のファイルを再帰的に検索する
	 */
	public async findFilesInDirectory(
		sourceDir: string,
		extensions: string[],
		includePattern: string,
		excludePattern: string,
	): Promise<string[]> {
		// VS Code APIを使用してファイルを検索
		const includeGlob = new vscode.RelativePattern(sourceDir, includePattern);
		const files: vscode.Uri[] = await vscode.workspace.findFiles(
			includeGlob,
			excludePattern,
		);

		// 指定された拡張子のファイルだけをフィルタリング
		return files
			.filter((file) => {
				const ext = path.extname(file.fsPath).toLowerCase();
				return extensions.includes(ext);
			})
			.map((file) => file.fsPath);
	}

	/**
	 * 設定に基づいてファイルを取得する
	 */
	public async getSourceFiles(config: Configuration): Promise<string[]> {
		let sourceDir = config.directories.source;
		// 相対パスの場合はワークスペースルートを基準に絶対パス化
		if (!path.isAbsolute(sourceDir)) {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error("ワークスペースが開かれていません");
			}
			sourceDir = path.resolve(workspaceFolders[0].uri.fsPath, sourceDir);
		}

		// ディレクトリの存在を確認
		if (!this.directoryExists(sourceDir)) {
			throw new Error(`翻訳元ディレクトリが存在しません: ${sourceDir}`);
		}

		// ファイルの検索
		return await this.findFilesInDirectory(
			sourceDir,
			config.files.extensions,
			config.files.includePattern,
			config.files.excludePattern,
		);
	}

	/**
	 * ソースファイルパスから対応するターゲットファイルパスを取得する
	 */
	public getTargetPath(sourcePath: string, config: Configuration): string {
		let sourceDir = config.directories.source;
		let targetDir = config.directories.target;
		// 相対パスの場合はワークスペースルートを基準に絶対パス化
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("ワークスペースが開かれていません");
		}
		sourceDir = path.resolve(workspaceFolders[0].uri.fsPath, sourceDir);
		targetDir = path.resolve(workspaceFolders[0].uri.fsPath, targetDir);

		// ソースディレクトリからの相対パスを取得
		const relativePath = path.relative(sourceDir, sourcePath);

		// ターゲットディレクトリに適用
		return path.join(targetDir, relativePath);
	}

	/**
	 * ターゲットファイルのディレクトリを作成する
	 */
	public ensureTargetDirectoryExists(targetPath: string): void {
		const targetDir = path.dirname(targetPath);

		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
		}
	}
}
