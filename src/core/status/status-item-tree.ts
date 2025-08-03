import * as path from "node:path";
import * as vscode from "vscode";
import { Status, type StatusItem, StatusItemType } from "./status-item";

/**
 * StatusItemのファーストクラスコレクション
 * ディレクトリ・ファイル・ユニットの階層構造を効率的に管理する
 */
export class StatusItemTree {
	private readonly fileMap = new Map<string, StatusItem>();
	private readonly directoryMap = new Map<string, StatusItem[]>();
	private readonly unitMap = new Map<string, StatusItem>();

	/**
	 * ファイルStatusItemを取得
	 */
	public getFile(filePath: string): StatusItem | undefined {
		return this.fileMap.get(filePath);
	}

	/**
	 * 指定ディレクトリ内のファイル一覧を取得
	 */
	public listFilesInDirectory(dirPath: string): StatusItem[] {
		return this.directoryMap.get(dirPath) || [];
	}

	/**
	 * 指定ファイル内のユニット一覧を取得
	 */
	public listUnitsInFile(filePath: string): StatusItem[] {
		const fileItem = this.fileMap.get(filePath);
		return fileItem?.children || [];
	}

	/**
	 * ユニットStatusItemを取得
	 */
	public getUnit(filePath: string, unitHash: string): StatusItem | undefined {
		const key = `${filePath}#${unitHash}`;
		return this.unitMap.get(key);
	}

	/**
	 * ユニットStatusItemを部分更新
	 */
	public updateUnit(filePath: string, unitHash: string, updates: Partial<StatusItem>): StatusItem | undefined {
		const key = `${filePath}#${unitHash}`;
		const unit = this.unitMap.get(key);
		if (!unit) {
			return undefined;
		}

		// ユニットを更新
		Object.assign(unit, updates);
		this.unitMap.set(key, unit);

		// 親ファイルの子要素も更新
		const fileItem = this.fileMap.get(filePath);
		if (fileItem?.children) {
			const unitIndex = fileItem.children.findIndex((child) => child.unitHash === unitHash);
			if (unitIndex >= 0) {
				fileItem.children[unitIndex] = unit;
			}
		}

		return unit;
	}

	/**
	 * 指定ディレクトリのStatusItemを生成
	 */
	public getDirectory(dirPath: string): StatusItem | undefined {
		const files = this.directoryMap.get(dirPath);
		if (!files || files.length === 0) {
			return undefined;
		}

		const dirName = path.basename(dirPath) || dirPath;
		const totalUnits = files.reduce((sum, file) => sum + (file.totalUnits ?? 0), 0);
		const translatedUnits = files.reduce((sum, file) => sum + (file.translatedUnits ?? 0), 0);

		// ディレクトリの全体ステータスを決定
		const status = this.determineDirectoryStatus(files);

		// ディレクトリのisTranslatingフラグを決定
		const isTranslating = files.some((file) => file.isTranslating === true);

		// sourceディレクトリの場合は翻訳ユニット数を表示しない
		const label = status === Status.Source ? `${dirName} (source)` : `${dirName} (${translatedUnits}/${totalUnits})`;

		return {
			type: StatusItemType.Directory,
			label,
			directoryPath: dirPath,
			status,
			isTranslating,
			contextValue: "mdaitDirectory",
		};
	}

	/**
	 * 指定ディレクトリ内のファイル一覧を取得
	 */
	public getDirectoryFiles(directoryPath: string): StatusItem[] {
		return Array.from(this.fileMap.values()).filter(
			(file) => file.filePath && path.dirname(file.filePath) === directoryPath,
		);
	}

	/**
	 * 指定ファイルパスのファイルアイテムを取得
	 */
	public getFileItem(filePath: string): StatusItem | undefined {
		return this.fileMap.get(filePath);
	}

	/**
	 * ファイルアイテムを追加または更新
	 */
	public addOrUpdateFile(fileItem: StatusItem): void {
		if (fileItem.type === StatusItemType.File && fileItem.filePath) {
			this.fileMap.set(fileItem.filePath, fileItem);

			// 子ユニットも登録
			if (fileItem.children) {
				for (const unit of fileItem.children) {
					if (unit.unitHash) {
						this.unitMap.set(unit.unitHash, unit);
					}
				}
			}
		}
	}

	/**
	 * 指定ファイルの翻訳ユニット一覧を取得
	 */
	public getFileUnits(filePath: string): StatusItem[] {
		const fileItem = this.fileMap.get(filePath);
		return fileItem?.children ?? [];
	}

	/**
	 * 全ファイルStatusItemを取得（既存API互換性用）
	 */
	public getAllFiles(): StatusItem[] {
		return Array.from(this.fileMap.values());
	}

	/**
	 * 全ディレクトリパス一覧を取得
	 */
	public getAllDirectoryPaths(): string[] {
		return Array.from(this.directoryMap.keys());
	}

	/**
	 * ツリーを初期化（全データクリア）
	 */
	public clear(): void {
		this.fileMap.clear();
		this.directoryMap.clear();
		this.unitMap.clear();
	}

	/**
	 * 指定ディレクトリ配下の直下ファイルのみを取得（サブディレクトリは除く）
	 */
	public getDirectFilesInDirectory(dirPath: string): StatusItem[] {
		const files = this.directoryMap.get(dirPath) || [];
		return files.filter((file) => {
			if (!file.filePath) return false;
			return path.dirname(file.filePath) === dirPath;
		});
	}

	/**
	 * 指定ディレクトリ配下の全サブディレクトリパスを取得
	 */
	public getSubDirectoryPaths(parentDir: string): string[] {
		const subDirs = new Set<string>();

		for (const dirPath of this.directoryMap.keys()) {
			if (dirPath !== parentDir && dirPath.startsWith(parentDir)) {
				const rel = path.relative(parentDir, dirPath);
				const parts = rel.split(path.sep);
				if (parts.length > 0 && parts[0] !== "" && parts[0] !== ".") {
					const subDirPath = path.join(parentDir, parts[0]);
					subDirs.add(subDirPath);
				}
			}
		}

		return Array.from(subDirs);
	}

	/**
	 * 指定ディレクトリ配下の全ファイル（サブディレクトリ含む）を取得
	 */
	public getAllFilesInDirectoryRecursive(dirPath: string): StatusItem[] {
		const result: StatusItem[] = [];

		for (const file of this.fileMap.values()) {
			if (file.filePath && path.dirname(file.filePath).startsWith(dirPath)) {
				result.push(file);
			}
		}

		return result;
	}

	/**
	 * 指定パスのファイルまたはディレクトリを検索
	 */
	public findByPath(targetPath: string): StatusItem | undefined {
		// ファイルから検索
		const file = this.fileMap.get(targetPath);
		if (file) return file;

		// ディレクトリとして検索
		return this.getDirectory(targetPath);
	}

	/**
	 * 指定ハッシュのユニットを検索（ファイルパス指定可能）
	 */
	public findUnitByHash(unitHash: string, filePath?: string): StatusItem | undefined {
		if (filePath) {
			// 特定ファイル内から検索
			const key = `${filePath}#${unitHash}`;
			return this.unitMap.get(key);
		}

		// 全ファイルから検索
		for (const [key, unit] of this.unitMap) {
			if (unit.unitHash === unitHash) {
				return unit;
			}
		}

		return undefined;
	}

	/**
	 * 指定fromHashのユニットを検索（ファイルパス指定可能）
	 */
	public findUnitByFromHash(fromHash: string, filePath?: string): StatusItem | undefined {
		if (filePath) {
			// 特定ファイル内から検索
			const fileItem = this.fileMap.get(filePath);
			if (fileItem?.children) {
				return fileItem.children.find((unit) => unit.fromHash === fromHash);
			}
		}

		// 全ファイルから検索
		for (const file of this.fileMap.values()) {
			if (file.children) {
				const found = file.children.find((unit) => unit.fromHash === fromHash);
				if (found) return found;
			}
		}

		return undefined;
	}

	/**
	 * 指定ファイル内の未翻訳ユニット（needFlag付き）を取得
	 */
	public getUntranslatedUnitsInFile(filePath: string): StatusItem[] {
		const fileItem = this.fileMap.get(filePath);
		if (!fileItem?.children) return [];

		return fileItem.children.filter((unit) => unit.type === StatusItemType.Unit && unit.needFlag);
	}

	/**
	 * 全体の進捗情報を集計
	 */
	public aggregateProgress(): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		let totalUnits = 0;
		let translatedUnits = 0;
		let errorUnits = 0;

		for (const unit of this.unitMap.values()) {
			if (unit.type === StatusItemType.Unit) {
				totalUnits++;
				if (unit.status === Status.Translated) {
					translatedUnits++;
				} else if (unit.status === Status.Error) {
					errorUnits++;
				}
			}
		}

		return { totalUnits, translatedUnits, errorUnits };
	}

	/**
	 * 指定ディレクトリの進捗情報を集計
	 */
	public aggregateDirectoryProgress(dirPath: string): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		const files = this.getAllFilesInDirectoryRecursive(dirPath);
		let totalUnits = 0;
		let translatedUnits = 0;
		let errorUnits = 0;

		for (const file of files) {
			if (file.children) {
				for (const unit of file.children) {
					if (unit.type === StatusItemType.Unit) {
						totalUnits++;
						if (unit.status === Status.Translated) {
							translatedUnits++;
						} else if (unit.status === Status.Error) {
							errorUnits++;
						}
					}
				}
			}
		}

		return { totalUnits, translatedUnits, errorUnits };
	}

	/**
	 * 配下にisTranslating=trueのファイルがあるかチェック
	 */
	public hasTranslatingFiles(dirPath: string): boolean {
		const files = this.getAllFilesInDirectoryRecursive(dirPath);
		return files.some((file) => file.isTranslating === true);
	}

	/**
	 * ルートディレクトリ一覧を取得（設定されたtransPairsに基づく）
	 */
	public getRootDirectoryItems(transPairDirs: string[]): StatusItem[] {
		const directoryItems: StatusItem[] = [];

		// transPairsで指定されたディレクトリのみを対象
		const rootDirs = transPairDirs.filter((dir) => this.directoryMap.has(dir));

		for (const dirPath of rootDirs) {
			const directoryItem = this.getDirectory(dirPath);
			if (directoryItem) {
				// 表示用に拡張プロパティを設定
				directoryItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				directoryItem.tooltip =
					directoryItem.status === Status.Source
						? `Source directory: ${path.basename(dirPath)}`
						: `Directory: ${path.basename(dirPath)} - ${directoryItem.label}`;
				directoryItems.push(directoryItem);
			}
		}

		return directoryItems;
	}

	/**
	 * 指定ディレクトリの子要素（ファイル・サブディレクトリ）を取得
	 * ツリー表示用に階層構造でStatusItemを返す
	 */
	public getDirectoryChildren(directoryPath: string): StatusItem[] {
		const items: StatusItem[] = [];

		// 直下のファイルを取得
		const directFiles = this.getDirectFilesInDirectory(directoryPath);
		items.push(...directFiles);

		// サブディレクトリを取得
		const subDirPaths = this.getSubDirectoryPaths(directoryPath);
		for (const subDirPath of subDirPaths) {
			const subDirItem = this.getDirectory(subDirPath);
			if (subDirItem) {
				subDirItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				subDirItem.tooltip =
					subDirItem.status === Status.Source
						? `Source directory: ${path.basename(subDirPath)}`
						: `Directory: ${path.basename(subDirPath)} - ${subDirItem.label}`;
				items.push(subDirItem);
			}
		}

		// ディレクトリ→ファイルの順で表示
		return [
			...items.filter((item) => item.type === StatusItemType.Directory),
			...items.filter((item) => item.type === StatusItemType.File),
		];
	}

	/**
	 * StatusTreeProviderのgetRootDirectoryItemsで使用するディレクトリマップを構築
	 */
	public buildDirectoryMapForProvider(transPairDirs: string[]): Map<string, StatusItem[]> {
		const directoryMap = new Map<string, StatusItem[]>();

		// transPairsで指定されたディレクトリのみを対象
		for (const dirPath of transPairDirs) {
			const files = this.listFilesInDirectory(dirPath);
			if (files.length > 0) {
				directoryMap.set(dirPath, files);
			}
		}

		return directoryMap;
	}

	/**
	 * ディレクトリの全体ステータスを決定する
	 */
	private determineDirectoryStatus(files: StatusItem[]): Status {
		if (files.length === 0) return Status.Unknown;

		const hasError = files.some((f) => f.status === Status.Error);
		if (hasError) return Status.Error;

		const allSource = files.every((f) => f.status === Status.Source);
		if (allSource) return Status.Source;

		const totalUnits = files.reduce((sum, f) => sum + (f.totalUnits ?? 0), 0);
		const translatedUnits = files.reduce((sum, f) => sum + (f.translatedUnits ?? 0), 0);

		if (totalUnits === 0) return Status.Unknown;
		if (translatedUnits === totalUnits) return Status.Translated;
		return Status.NeedsTranslation;
	}
}
