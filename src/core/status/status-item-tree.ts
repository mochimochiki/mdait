import * as path from "node:path";
import * as vscode from "vscode";
import {
	Status,
	type StatusItem,
	StatusItemType,
	type DirectoryStatusItem,
	type FileStatusItem,
	type UnitStatusItem,
	isFileStatusItem,
	isDirectoryStatusItem,
} from "./status-item";

/**
 * StatusItemのファーストクラスコレクション
 * ディレクトリ・ファイル・ユニットの階層構造を効率的に管理する
 */
export class StatusItemTree {
	// ========== event ==========
	// Event
	private readonly _onTreeChanged = new vscode.EventEmitter<StatusItem | undefined>();
	public readonly onTreeChanged: vscode.Event<StatusItem | undefined> = this._onTreeChanged.event;

	// ========== member ==========
	private readonly fileItemMap = new Map<string, FileStatusItem>(); // ファイルパスをキーとする
	private readonly directoryItemMap = new Map<string, DirectoryStatusItem>(); // ディレクトリパスをキーとする
	private readonly unitItemMapWithPath = new Map<string, UnitStatusItem>(); // ファイルパス+ユニットハッシュをキーとする
	private rootDirectories: string[] = [];

	// ========== 取得 ==========

	/**
	 * ステータスツリーが空かどうかを判定
	 * @returns true: ファイルが1つも登録されていない、false: 1つ以上登録されている
	 */
	public isEmpty(): boolean {
		return this.fileItemMap.size === 0;
	}

	/**
	 * ファイルStatusItemを取得
	 */
	public getFile(filePath: string): FileStatusItem | undefined {
		return this.fileItemMap.get(filePath);
	}

	/**
	 * 全ファイルStatusItemを取得（既存API互換性用）
	 */
	public getFilesAll(): FileStatusItem[] {
		return Array.from(this.fileItemMap.values());
	}

	/**
	 * 全ソースファイルStatusItemを取得
	 */
	public getSourceFilesAll(): FileStatusItem[] {
		return Array.from(this.fileItemMap.values()).filter((file) => file.status === Status.Source);
	}

	/**
	 * 指定ディレクトリ配下の全ファイル（サブディレクトリ含む）を取得
	 */
	public getFilesInDirectoryRecursive(dirPath: string): FileStatusItem[] {
		const result: FileStatusItem[] = [];

		for (const file of this.fileItemMap.values()) {
			if (path.dirname(file.filePath).startsWith(dirPath)) {
				result.push(file);
			}
		}

		return result;
	}

	/**
	 * 指定ディレクトリ配下の直下ファイルのみを取得（サブディレクトリは除く）
	 */
	private getFilesInDirectoryDirect(dirPath: string): FileStatusItem[] {
		const directoryItem = this.directoryItemMap.get(dirPath);
		if (!directoryItem?.children) return [];

		return directoryItem.children.filter((file): file is FileStatusItem => {
			if (!isFileStatusItem(file)) return false;
			return path.dirname(file.filePath) === dirPath;
		});
	}

	/**
	 * 指定ハッシュのユニットを取得
	 */
	public getUnit(unitHash: string, filePath: string): UnitStatusItem | undefined {
		// 特定ファイル内から検索
		const key = `${filePath}#${unitHash}`;
		if (this.unitItemMapWithPath.has(key)) {
			return this.unitItemMapWithPath.get(key);
		}
		return undefined;
	}

	/**
	 * 指定ファイルの翻訳ユニット一覧を取得
	 */
	public getUnitsInFile(filePath: string): UnitStatusItem[] {
		const fileItem = this.fileItemMap.get(filePath);
		return fileItem?.children ?? [];
	}

	/**
	 * 指定ハッシュのユニットを検索（ファイルパスなしでスキャン）
	 * 全ファイルから検索するため、どのファイルか不定であることに注意
	 */
	public getUnitByHash(unitHash: string): UnitStatusItem | undefined {
		// 全ファイルから検索（ハッシュのみでスキャン）
		for (const [key, unit] of this.unitItemMapWithPath) {
			if (unit.unitHash === unitHash) {
				return unit;
			}
		}

		return undefined;
	}

	/**
	 * 指定ファイル内の未翻訳ユニット（needFlag付き）を取得
	 */
	public getUnitsUntranslatedInFile(filePath: string): UnitStatusItem[] {
		const fileItem = this.fileItemMap.get(filePath);
		if (!fileItem?.children) return [];

		return fileItem.children.filter((unit) => unit.needFlag);
	}

	/**
	 * 指定ディレクトリのStatusItemを取得
	 */
	public getDirectory(dirPath: string): DirectoryStatusItem | undefined {
		// 既存のディレクトリStatusItemを返す
		return this.directoryItemMap.get(dirPath);
	}

	/**
	 * 指定ディレクトリの子要素（ファイル・サブディレクトリ）を取得
	 * ツリー表示用に階層構造でStatusItemを返す
	 */
	public getDirectoryChildren(directoryPath: string): StatusItem[] {
		const items: StatusItem[] = [];

		// 直下のファイルを取得
		const directFiles = this.getFilesInDirectoryDirect(directoryPath);
		items.push(...directFiles);

		// サブディレクトリを取得
		const subDirPaths = this.getSubDirectoryPaths(directoryPath);
		for (const subDirPath of subDirPaths) {
			const subDirItem = this.getDirectory(subDirPath);
			if (subDirItem) {
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
	 * ルートディレクトリ一覧を取得（設定されたtransPairsに基づく）
	 */
	public getRootDirectoryItems(transPairDirs: string[]): DirectoryStatusItem[] {
		return transPairDirs
			.map((dirPath) => this.getDirectory(dirPath))
			.filter((item): item is DirectoryStatusItem => !!item);
	}

	// ========== 集計 ==========

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

		for (const unit of this.unitItemMapWithPath.values()) {
			// ソースユニット（fromHashを持たないユニット）はカウントしない
			if (unit.status === Status.Source) {
				continue;
			}
			totalUnits++;
			if (unit.status === Status.Translated) {
				translatedUnits++;
			} else if (unit.status === Status.Error) {
				errorUnits++;
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
		const files = this.getFilesInDirectoryRecursive(dirPath);
		let totalUnits = 0;
		let translatedUnits = 0;
		let errorUnits = 0;

		for (const file of files) {
			if (file.children) {
				for (const unit of file.children) {
					// ソースユニット（fromHashを持たないユニット）はカウントしない
					if (unit.status === Status.Source) {
						continue;
					}
					totalUnits++;
					if (unit.status === Status.Translated) {
						translatedUnits++;
					} else if (unit.status === Status.Error) {
						errorUnits++;
					}
				}
			}
		}

		return { totalUnits, translatedUnits, errorUnits };
	}

	// ========== 操作 ==========

	/**
	 * ツリーを初期化
	 */
	public clear(): void {
		this.fileItemMap.clear();
		this.directoryItemMap.clear();
		this.unitItemMapWithPath.clear();
		this.rootDirectories = [];
	}

	public dispose(): void {
		// EventEmitterの破棄
		this._onTreeChanged.dispose();
	}

	/**
	 * ツリーを構築
	 * @param files - FileStatusItemの配列
	 */
	public buildTree(files: FileStatusItem[], rootDirs: string[]): void {
		this.clear();
		this.rootDirectories = rootDirs;

		console.log("=>build");
		const startTime = performance.now();
		for (const file of files) {
			this.addOrUpdateFile(file);
		}

		const endTime = performance.now();
		console.log(`<=build (${Math.round(endTime - startTime)}ms)`);
	}

	/**
	 * FileItemを更新
	 */
	public addOrUpdateFile(fileItem: FileStatusItem): void {
		fileItem.isTranslating = false; // 翻訳中フラグをリセット
		if (fileItem.children) {
			fileItem.isTranslating = fileItem.children.some((unit) => unit.isTranslating === true);
		}

		const existingItem = this.fileItemMap.get(fileItem.filePath);
		if (existingItem) {
			// 既存のファイルStatusItemを更新
			// Assignを使うことでStatusItemのインスタンス自体は保持しつつ、最新の状態に更新(代入してしまうとgetTreeItemで古い状態が返る可能性があるため)
			Object.assign(existingItem, fileItem);
		} else {
			this.fileItemMap.set(fileItem.filePath, fileItem);
		}

		// 子ユニットも登録（ファイルパス + ハッシュで一意性確保）
		if (fileItem.children) {
			for (const unit of fileItem.children) {
				const key = `${fileItem.filePath}#${unit.unitHash}`;
				// 既存のユニットを更新
				const existingUnit = this.unitItemMapWithPath.get(key);
				if (existingUnit) {
					Object.assign(existingUnit, unit);
				} else {
					this.unitItemMapWithPath.set(key, unit);
				}
			}
		}

		// ディレクトリ更新
		this.addOrUpdateDirectory(fileItem);
	}

	public updateFilePartial(filePath: string, updates: Partial<FileStatusItem>): FileStatusItem | undefined {
		const existingItem = this.fileItemMap.get(filePath);
		if (!existingItem) {
			return undefined;
		}

		// 既存のファイルStatusItemを更新
		Object.assign(existingItem, updates);

		// ディレクトリ更新
		this.addOrUpdateDirectory(existingItem);
		return existingItem;
	}

	/**
	 * DirectoryItemを部分更新
	 */
	public updateDirectoryPartial(
		directoryPath: string,
		updates: Partial<DirectoryStatusItem>,
	): DirectoryStatusItem | undefined {
		const existingItem = this.directoryItemMap.get(directoryPath);
		if (!existingItem) {
			return undefined;
		}

		// 既存のディレクトリStatusItemを更新
		Object.assign(existingItem, updates);

		// イベント通知
		this._onTreeChanged.fire(existingItem);
		return existingItem;
	}

	/**
	 * UnitItemを部分更新
	 */
	public updateUnit(filePath: string, unitHash: string, updates: Partial<UnitStatusItem>): UnitStatusItem | undefined {
		const key = `${filePath}#${unitHash}`;
		const unit = this.unitItemMapWithPath.get(key);
		if (!unit) {
			return undefined;
		}

		// ユニットを更新
		Object.assign(unit, updates);

		// 親ファイルの子要素も更新
		const fileItem = this.fileItemMap.get(filePath);
		if (fileItem?.children) {
			const unitIndex = fileItem.children.findIndex((child) => child.unitHash === unitHash);
			if (unitIndex >= 0) {
				Object.assign(fileItem.children[unitIndex], unit);
				this.addOrUpdateFile(fileItem);
			}
		}

		return unit;
	}

	// ========== Private methods ==========

	/**
	 * 特定のファイルに対してディレクトリマップを更新
	 */
	private addOrUpdateDirectory(fileItem: FileStatusItem): void {
		const dirPath = path.dirname(fileItem.filePath);
		const stopRoot = this.getRootDir(dirPath);
		const directoryItem = this.directoryItemMap.get(dirPath);
		if (directoryItem) {
			directoryItem.children = directoryItem.children || [];
			const index = directoryItem.children.findIndex(
				(f) => isFileStatusItem(f) && f.filePath === fileItem.filePath,
			);
			if (index >= 0) {
				Object.assign(directoryItem.children[index], fileItem);
			} else {
				directoryItem.children.push(fileItem);
			}
		}

		// 子の更新や集計はすべてこちらで面倒を見る
		this.updateDirectoryAggregatesUpward(dirPath, stopRoot);
	}

	/**
	 * 指定ディレクトリから親方向へ集計を再帰更新する（最上位でイベント発火）
	 */
	private updateDirectoryAggregatesUpward(dirPath: string, stopRoot?: string): void {
		const effectiveStopRoot = stopRoot ?? this.getRootDir(dirPath);
		let directoryItem = this.directoryItemMap.get(dirPath);
		if (!directoryItem) {
			// 直下ファイルを fileItemMap から収集して作成
			const directFiles = Array.from(this.fileItemMap.values()).filter(
				(f) => path.dirname(f.filePath) === dirPath,
			);
			directoryItem = this.createDirectoryStatusItem(dirPath, directFiles);
			this.directoryItemMap.set(dirPath, directoryItem);
		}

		// 集計の更新（共通処理）
		this.recalcDirectoryAggregate(dirPath, directoryItem);

		// 親があれば継続。なければここでイベント発火。
		const parentDir = path.dirname(dirPath);
		if (dirPath !== effectiveStopRoot) {
			this.updateDirectoryAggregatesUpward(parentDir, effectiveStopRoot);
		} else {
			this._onTreeChanged.fire(directoryItem);
		}
	}

	/**
	 * 再帰の停止ルートを判定する
	 */
	private getRootDir(dirPath: string): string {
		const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		try {
			// rootDirectoriesのいずれかの子孫か（ディレクトリ階層で比較）
			for (const rootDir of this.rootDirectories) {
				const absoluteRootDir = wsFolder ? path.resolve(wsFolder, rootDir) : rootDir;
				const absoluteDirPath = path.resolve(dirPath);
				// ディレクトリ階層で比較
				if (absoluteDirPath === absoluteRootDir || absoluteDirPath.startsWith(absoluteRootDir + path.sep)) {
					return absoluteRootDir;
				}
			}
		} catch {
			// FileExplorer 初期化不可などは無視してフォールバック
		}
		// フォールバック：ワークスペース、なければドライブルート
		if (wsFolder) return path.resolve(wsFolder);
		return path.parse(path.resolve(dirPath)).root;
	}

	/**
	 * ディレクトリの集計・表示情報を更新（共通処理）
	 */
	private recalcDirectoryAggregate(dirPath: string, directoryItem: DirectoryStatusItem): void {
		// 直下ファイルまたはサブディレクトリがある場合は折りたたみ可能
		{
			const hasFiles = !!directoryItem.children && directoryItem.children.length > 0;
			const hasSubDirs = this.getSubDirectoryPaths(dirPath).length > 0;
			directoryItem.collapsibleState =
				hasFiles || hasSubDirs ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
		}

		// 再帰的に配下すべてのファイルから集計
		const allFiles = this.getFilesInDirectoryRecursive(dirPath);
		directoryItem.status = this.determineMergedStatus(allFiles);

		// ディレクトリのisTranslatingフラグを決定（再帰）
		directoryItem.isTranslating = allFiles.some((file) => file.isTranslating === true);

		// ディレクトリのラベル/集計値を更新（再帰）
		const totalUnits = allFiles.reduce((sum, file) => sum + file.totalUnits, 0);
		const translatedUnits = allFiles.reduce((sum, file) => sum + file.translatedUnits, 0);
		const dirName = path.basename(directoryItem.directoryPath) || directoryItem.directoryPath;
		directoryItem.label =
			directoryItem.status === Status.Source ? `${dirName}` : `${dirName} (${translatedUnits}/${totalUnits})`;

		directoryItem.totalUnits = totalUnits;
		directoryItem.translatedUnits = translatedUnits;
	}

	/**
	 * ディレクトリStatusItemを作成
	 */
	private createDirectoryStatusItem(dirPath: string, files: FileStatusItem[]): DirectoryStatusItem {
		const dirName = path.basename(dirPath) || dirPath;

		// 再帰的に配下すべてのファイルから集計
		const allFiles = this.getFilesInDirectoryRecursive(dirPath);
		const totalUnits = allFiles.reduce((sum, file) => sum + file.totalUnits, 0);
		const translatedUnits = allFiles.reduce((sum, file) => sum + file.translatedUnits, 0);

		// ディレクトリの全体ステータスを決定（再帰）
		const status = this.determineMergedStatus(allFiles);

		// ディレクトリのisTranslatingフラグを決定（再帰）
		const isTranslating = allFiles.some((file) => file.isTranslating === true);

		// sourceディレクトリの場合は翻訳ユニット数を表示しない
		const label = status === Status.Source ? `${dirName}` : `${dirName} (${translatedUnits}/${totalUnits})`;

		return {
			type: StatusItemType.Directory,
			label,
			directoryPath: dirPath,
			status,
			isTranslating,
			contextValue: status === Status.Source ? "mdaitDirectorySource" : "mdaitDirectoryTarget",
			children: [...files], // 直下ファイルのコピーを保持
			totalUnits,
			translatedUnits,
			collapsibleState: (() => {
				const hasFiles = files.length > 0;
				const hasSubDirs = this.getSubDirectoryPaths(dirPath).length > 0;
				return hasFiles || hasSubDirs
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None;
			})(),
		};
	}

	/**
	 * 指定ディレクトリ配下の全サブディレクトリパスを取得
	 */
	private getSubDirectoryPaths(parentDir: string): string[] {
		const subDirs = new Set<string>();

		for (const dirPath of this.directoryItemMap.keys()) {
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
	 * 複数アイテムをマージした全体ステータスを決定する
	 */
	private determineMergedStatus(files: FileStatusItem[]): Status {
		if (files.length === 0) return Status.Unknown;

		const hasError = files.some((f) => f.status === Status.Error);
		if (hasError) return Status.Error;

		const allSource = files.every((f) => f.status === Status.Source || f.status === Status.Empty);
		if (allSource) return Status.Source;

		const totalUnits = files.reduce((sum, f) => sum + f.totalUnits, 0);
		const translatedUnits = files.reduce((sum, f) => sum + f.translatedUnits, 0);

		if (totalUnits === 0) return Status.Unknown;
		if (translatedUnits === totalUnits) return Status.Translated;
		return Status.NeedsTranslation;
	}
}
