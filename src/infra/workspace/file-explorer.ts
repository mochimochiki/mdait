import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../config/configuration";
import type { TransPair } from "../config/configuration";

/**
 * `/` 区切りのパスから表記のゆれを畳む（`./x` → `x`、`x/` → `x`、`a//b` → `a/b`、`a/./b` → `a/b`）。
 *
 * `path.posix.normalize` は末尾の `/` を残すので自分で落とす。`.`（カレント）は空文字にする。
 * ルート（`/`）だけは落とさない（落とすと空文字になり別の意味になる）。
 */
function collapsePathNotation(slashPath: string): string {
	if (slashPath === "") {
		return "";
	}
	let collapsed = path.posix.normalize(slashPath);
	if (collapsed.length > 1) {
		collapsed = collapsed.replace(/\/+$/, "");
	}
	return collapsed === "." ? "" : collapsed;
}

/**
 * ファイル探索とファイル種別解決を統合的に行うクラス
 *
 * このクラスは以下の責務を持つ：
 * - ファイル探索とディレクトリ操作
 * - ファイルパスからソース/ターゲットの判定
 * - 翻訳ペア設定の取得
 * - パスの正規化と変換
 * - 設定ファイル相対パス管理
 */
export class FileExplorer {
	/**
	 * パス解決の基準ディレクトリ。
	 * .mdait/mdait.json の親ディレクトリ（ユーザーが管理するフォルダ）を返す。
	 * カスタムパスなしの場合はワークスペースルートと同一。
	 */
	private get configBaseDir(): string {
		try {
			return Configuration.getInstance().getConfigBaseDir();
		} catch {
			// Configuration 未初期化時はワークスペースルートにフォールバック
			const workspaceFolders = vscode.workspace.workspaceFolders;
			return workspaceFolders?.[0]?.uri.fsPath ?? "";
		}
	}

	constructor() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found");
		}
	}

	/**
	 * ターゲットファイルから対応する翻訳ペアを取得
	 */
	public getTransPairFromTarget(filePath: string, config: Configuration): TransPair | null {
		const normalizedPath = this.normalizePath(filePath);

		for (const transPair of config.transPairs) {
			const normalizedTargetDir = this.normalizePath(transPair.targetDir);

			if (this.isPathInDirectory(normalizedPath, normalizedTargetDir)) {
				return transPair;
			}
		}

		return null;
	}

	/**
	 * ソースファイルから対応する翻訳ペア配列を取得（設定順を維持）
	 * 1つのソースに対して複数のターゲット言語がある場合があるため配列で返す
	 */
	public getTransPairsFromSource(filePath: string, config: Configuration): TransPair[] {
		const normalizedPath = this.normalizePath(filePath);
		const result: TransPair[] = [];

		for (const transPair of config.transPairs) {
			const normalizedSourceDir = this.normalizePath(transPair.sourceDir);

			if (this.isPathInDirectory(normalizedPath, normalizedSourceDir)) {
				result.push(transPair);
			}
		}

		return result;
	}

	/**
	 * ファイルがソースファイルかどうかを判定
	 */
	public isSourceFile(filePath: string, config: Configuration): boolean {
		const normalizedPath = this.normalizePath(filePath);
		for (const transPair of config.transPairs) {
			const normalizedSourceDir = this.normalizePath(transPair.sourceDir);

			if (this.isPathInDirectory(normalizedPath, normalizedSourceDir)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * ファイルがターゲットファイルかどうかを判定
	 */
	public isTargetFile(filePath: string, config: Configuration): boolean {
		const normalizedPath = this.normalizePath(filePath);
		for (const transPair of config.transPairs) {
			const normalizedTargetDir = this.normalizePath(transPair.targetDir);

			if (this.isPathInDirectory(normalizedPath, normalizedTargetDir)) {
				return true;
			}
		}
		return false;
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
	 * 拡張子リストからglobパターンを構築する。
	 * .md は常に含まれる。
	 */
	public static buildExtensionGlob(extensions?: string[]): string {
		const allExtensions = [".md", ...(extensions ?? [])];
		const uniqueExtensions = [...new Set(allExtensions)];
		if (uniqueExtensions.length === 1) {
			return "**/*.md";
		}
		const extStr = uniqueExtensions.map((e) => e.slice(1)).join(",");
		return `**/*.{${extStr}}`;
	}

	/**
	 * 設定に基づいてファイルを取得する
	 * @param extensions 追加の拡張子配列（省略時は.mdのみ、既存動作を維持）
	 */
	public async getSourceFiles(
		sourceDirConfig: string,
		config: Configuration,
		extensions?: string[],
	): Promise<string[]> {
		let sourceDir = sourceDirConfig;
		if (!path.isAbsolute(sourceDir)) {
			sourceDir = path.resolve(this.configBaseDir, sourceDir);
		}

		// ディレクトリの存在を確認
		if (!this.directoryExists(sourceDir)) {
			throw new Error(vscode.l10n.t("Source directory does not exist: {0}", sourceDir));
		}

		const allExtensions = [".md", ...(extensions ?? [])];
		const uniqueExtensions = [...new Set(allExtensions)];
		const globPattern = FileExplorer.buildExtensionGlob(extensions);
		return await this.findFilesInDirectory(sourceDir, uniqueExtensions, globPattern, config.ignoredPatterns);
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
	public getTargetPath(sourceFilePath: string, pair: TransPair): string | null {
		const normalizedSourceDir = this.normalizePath(pair.sourceDir);
		const normalizedTargetDir = this.normalizePath(pair.targetDir);
		const relativePath = this.getRelativePathFromDirectory(this.normalizePath(sourceFilePath), normalizedSourceDir);

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
	public getSourcePath(targetFilePath: string, pair: TransPair): string | null {
		const normalizedSourceDir = this.normalizePath(pair.sourceDir);
		const normalizedTargetDir = this.normalizePath(pair.targetDir);
		const relativePath = this.getRelativePathFromDirectory(this.normalizePath(targetFilePath), normalizedTargetDir);

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

	/**
	 * パスを正規化（スラッシュ統一、表記ゆれの畳み込み、設定ベースディレクトリ相対パス化）
	 *
	 * 正規化された文字列同士は前方一致で「配下かどうか」を判定される（`isPathInDirectory`）。
	 * したがって**同じ場所を指す表記は必ず同じ文字列にならなければならない**。
	 * `"./content/ja"` や `"content/ja/"` を畳まずに返していたため、`mdait.json` に
	 * `sourceDir: "./content/ja"` と書くだけで `getTargetPath` が null を返し、
	 * 1ファイルも同期されないうえ訳文側の `unit-state` の行が sync 1回で全部消えていた
	 * （`validateForRun` は `"./docs"` を正当な書き方として想定している）。
	 */
	public normalizePath(inputPath: string): string {
		let normalizedPath = collapsePathNotation(inputPath.replace(/\\/g, "/"));

		// 絶対パスの場合は設定ベースディレクトリ相対パスに変換
		if (path.isAbsolute(normalizedPath)) {
			const baseDirNormalized = this.configBaseDir.replace(/\\/g, "/");
			// path.relative を用いることで Windows のドライブレター大文字小文字差や
			// 兄弟ディレクトリのプレフィックス誤一致に左右されず判定できる。
			const relative = path.relative(baseDirNormalized, normalizedPath).replace(/\\/g, "/");
			// ベースディレクトリ配下にある場合のみ相対パス化（外部・別ドライブは絶対のまま）。
			// relative==="" はベース自身を指すため配下外扱い（相対化せず絶対のまま残す）。
			if (relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)) {
				normalizedPath = collapsePathNotation(relative);
			}
		}

		return normalizedPath;
	}

	// ========== 内部ユーティリティメソッド ==========

	/**
	 * 正規化されたパスを元の形式に戻す（絶対パス化）
	 */
	private denormalizePath(normalizedPath: string): string {
		if (path.isAbsolute(normalizedPath)) {
			return normalizedPath;
		}

		return path.resolve(this.configBaseDir, normalizedPath);
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
