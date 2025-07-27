import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration, TransPair } from "../config/configuration";

/**
 * ファイルの種別（ソース・ターゲット）を判定する結果
 */
export interface FileClassification {
	/** ファイルの種別 */
	type: "source" | "target" | "unknown";
	/** 対応する翻訳ペア設定 */
	transPair: TransPair | null;
	/** 正規化されたファイルパス */
	normalizedPath: string;
}

/**
 * ファイル探索とファイル種別解決を統合的に行うクラス
 *
 * このクラスは以下の責務を持つ：
 * - ファイル探索とディレクトリ操作
 * - ファイルパスからソース/ターゲットの判定
 * - 翻訳ペア設定の取得
 * - パスの正規化と変換
 * - ワークスペース相対パス管理
 */
export class FileExplorer {
	private readonly workspaceRoot: string;

	constructor() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found");
		}
		this.workspaceRoot = workspaceFolders[0].uri.fsPath;
	}
	/**
	 * ファイルパスを分析してソース/ターゲット種別を判定
	 *
	 * @param filePath 判定対象のファイルパス（絶対パスまたは相対パス）
	 * @param config 翻訳設定
	 * @returns ファイル分類結果
	 */
	public classifyFile(filePath: string, config: Configuration): FileClassification {
		const normalizedPath = this.normalizePath(filePath);

		// ソースファイル判定
		for (const transPair of config.transPairs) {
			const normalizedSourceDir = this.normalizePath(transPair.sourceDir);

			if (this.isPathInDirectory(normalizedPath, normalizedSourceDir)) {
				return {
					type: "source",
					transPair,
					normalizedPath,
				};
			}
		}

		// ターゲットファイル判定
		for (const transPair of config.transPairs) {
			const normalizedTargetDir = this.normalizePath(transPair.targetDir);

			if (this.isPathInDirectory(normalizedPath, normalizedTargetDir)) {
				return {
					type: "target",
					transPair,
					normalizedPath,
				};
			}
		}

		return {
			type: "unknown",
			transPair: null,
			normalizedPath,
		};
	}

	/**
	 * ファイルがソースファイルかどうかを判定
	 */
	public isSourceFile(filePath: string, config: Configuration): boolean {
		return this.classifyFile(filePath, config).type === "source";
	}

	/**
	 * ファイルがターゲットファイルかどうかを判定
	 */
	public isTargetFile(filePath: string, config: Configuration): boolean {
		return this.classifyFile(filePath, config).type === "target";
	}

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
		const files: vscode.Uri[] = await vscode.workspace.findFiles(includeGlob, excludePattern);

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
	public async getSourceFiles(sourceDirConfig: string, config: Configuration): Promise<string[]> {
		let sourceDir = sourceDirConfig;
		if (!path.isAbsolute(sourceDir)) {
			sourceDir = path.resolve(this.workspaceRoot, sourceDir);
		}

		// ディレクトリの存在を確認
		if (!this.directoryExists(sourceDir)) {
			throw new Error(vscode.l10n.t("Source directory does not exist: {0}", sourceDir));
		}
		// ファイルの検索（Markdownファイルのみを対象とする）
		return await this.findFilesInDirectory(sourceDir, [".md"], "**/*.md", config.ignoredPatterns);
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

	/**
	 * ソースファイルパスから対応するターゲットファイルパスを生成（設定ベース）
	 */
	public getTargetPathFromConfig(sourceFilePath: string, config: Configuration): string | null {
		const classification = this.classifyFile(sourceFilePath, config);

		if (classification.type !== "source" || !classification.transPair) {
			return null;
		}

		const transPair = classification.transPair;
		const normalizedSourceDir = this.normalizePath(transPair.sourceDir);
		const normalizedTargetDir = this.normalizePath(transPair.targetDir);

		// ソースディレクトリからの相対パスを取得
		const relativePath = this.getRelativePathFromDirectory(classification.normalizedPath, normalizedSourceDir);

		if (!relativePath) {
			return null;
		}

		// ターゲットディレクトリに相対パスを結合
		const targetPath = path.join(normalizedTargetDir, relativePath);
		return this.denormalizePath(targetPath);
	}

	/**
	 * ターゲットファイルパスから対応するソースファイルパスを生成（設定ベース）
	 */
	public getSourcePathFromConfig(targetFilePath: string, config: Configuration): string | null {
		const classification = this.classifyFile(targetFilePath, config);

		if (classification.type !== "target" || !classification.transPair) {
			return null;
		}

		const transPair = classification.transPair;
		const normalizedSourceDir = this.normalizePath(transPair.sourceDir);
		const normalizedTargetDir = this.normalizePath(transPair.targetDir);

		// ターゲットディレクトリからの相対パスを取得
		const relativePath = this.getRelativePathFromDirectory(classification.normalizedPath, normalizedTargetDir);

		if (!relativePath) {
			return null;
		}

		// ソースディレクトリに相対パスを結合
		const sourcePath = path.join(normalizedSourceDir, relativePath);
		return this.denormalizePath(sourcePath);
	}

	/**
	 * 重複のないディレクトリリストを取得
	 */
	public getUniqueDirectories(config: Configuration): {
		sourceDirs: string[];
		targetDirs: string[];
	} {
		const allTargetDirs = new Set<string>();
		const allSourceDirs = new Set<string>();

		// 全てのtargetディレクトリを収集
		for (const transPair of config.transPairs) {
			allTargetDirs.add(transPair.targetDir);
		}

		// sourceディレクトリを収集（targetに含まれていないもののみ）
		for (const transPair of config.transPairs) {
			if (!allTargetDirs.has(transPair.sourceDir)) {
				allSourceDirs.add(transPair.sourceDir);
			}
		}

		return {
			sourceDirs: Array.from(allSourceDirs),
			targetDirs: Array.from(allTargetDirs),
		};
	}

	// ========== 内部ユーティリティメソッド ==========

	/**
	 * パスを正規化（スラッシュ統一、ワークスペース相対パス化）
	 */
	private normalizePath(inputPath: string): string {
		let normalizedPath = inputPath.replace(/\\/g, "/");

		// 絶対パスの場合はワークスペース相対パスに変換
		if (path.isAbsolute(normalizedPath)) {
			const workspaceNormalized = this.workspaceRoot.replace(/\\/g, "/");
			if (normalizedPath.startsWith(workspaceNormalized)) {
				normalizedPath = path.relative(workspaceNormalized, normalizedPath).replace(/\\/g, "/");
			}
		}

		return normalizedPath;
	}

	/**
	 * 正規化されたパスを元の形式に戻す（絶対パス化）
	 */
	private denormalizePath(normalizedPath: string): string {
		if (path.isAbsolute(normalizedPath)) {
			return normalizedPath;
		}

		return path.resolve(this.workspaceRoot, normalizedPath);
	}

	/**
	 * パスが指定ディレクトリ配下にあるかチェック
	 */
	private isPathInDirectory(filePath: string, directoryPath: string): boolean {
		return filePath.startsWith(`${directoryPath}/`) || filePath === directoryPath;
	}

	/**
	 * ディレクトリからの相対パスを取得
	 */
	private getRelativePathFromDirectory(filePath: string, directoryPath: string): string | null {
		if (filePath === directoryPath) {
			return "";
		}

		if (filePath.startsWith(`${directoryPath}/`)) {
			return filePath.substring(directoryPath.length + 1);
		}

		return null;
	}
}
