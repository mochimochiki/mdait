import { on } from "node:events";
import * as path from "node:path";
import * as vscode from "vscode";
import { Status, type StatusItem, StatusItemType } from "./status-item";

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
	private readonly fileItemMap = new Map<string, StatusItem>(); // ファイルパスをキーとする
	private readonly directoryItemMap = new Map<string, StatusItem>(); // ディレクトリパスをキーとする
	private readonly unitItemMapWithPath = new Map<string, StatusItem>(); // ファイルパス+ユニットハッシュをキーとする

	// ========== 取得 ==========

	/**
	 * ファイルStatusItemを取得
	 */
	public getFile(filePath: string): StatusItem | undefined {
		return this.fileItemMap.get(filePath);
	}

	/**
	 * 全ファイルStatusItemを取得（既存API互換性用）
	 */
	public getFilesAll(): StatusItem[] {
		return Array.from(this.fileItemMap.values());
	}

	/**
	 * 指定ディレクトリ配下の全ファイル（サブディレクトリ含む）を取得
	 */
	public getFilesInDirectoryRecursive(dirPath: string): StatusItem[] {
		const result: StatusItem[] = [];

		for (const file of this.fileItemMap.values()) {
			if (file.filePath && path.dirname(file.filePath).startsWith(dirPath)) {
				result.push(file);
			}
		}

		return result;
	}

	/**
	 * 指定ディレクトリ配下の直下ファイルのみを取得（サブディレクトリは除く）
	 */
	private getFilesInDirectoryDirect(dirPath: string): StatusItem[] {
		const directoryItem = this.directoryItemMap.get(dirPath);
		if (!directoryItem?.children) return [];

		return directoryItem.children.filter((file) => {
			if (!file.filePath) return false;
			return path.dirname(file.filePath) === dirPath;
		});
	}

	/**
	 * 指定ハッシュのユニットを取得
	 */
	public getUnit(unitHash: string, filePath: string): StatusItem | undefined {
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
	public getUnitsInFile(filePath: string): StatusItem[] {
		const fileItem = this.fileItemMap.get(filePath);
		return fileItem?.children ?? [];
	}

	/**
	 * 指定ハッシュのユニットを検索（ファイルパスなしでスキャン）
	 * 全ファイルから検索するため、どのファイルか不定であることに注意
	 */
	public getUnitFirstWithoutPath(unitHash: string): StatusItem | undefined {
		// 全ファイルから検索（ハッシュのみでスキャン）
		for (const [key, unit] of this.unitItemMapWithPath) {
			if (unit.unitHash === unitHash) {
				return unit;
			}
		}

		return undefined;
	}

	/**
	 * 指定fromHashのユニットを検索（ファイルパス指定）
	 */
	public getUnitByFromHash(fromHash: string, filePath: string): StatusItem | undefined {
		// 特定ファイル内から検索
		const fileItem = this.fileItemMap.get(filePath);
		if (fileItem?.children) {
			return fileItem.children.find((unit) => unit.fromHash === fromHash);
		}

		return undefined;
	}

	/**
	 * 指定ハッシュのユニットを検索（ファイルパスなしでスキャン）
	 * 全ファイルから検索するため、どのファイルか不定であることに注意
	 */
	public getUnitByFromHashFirstWithoutPath(fromHash: string): StatusItem | undefined {
		// 全ファイルから検索
		for (const file of this.fileItemMap.values()) {
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
	public getUnitsUntranslatedInFile(filePath: string): StatusItem[] {
		const fileItem = this.fileItemMap.get(filePath);
		if (!fileItem?.children) return [];

		return fileItem.children.filter((unit) => unit.type === StatusItemType.Unit && unit.needFlag);
	}

	/**
	 * 指定ディレクトリのStatusItemを取得
	 */
	public getDirectory(dirPath: string): StatusItem | undefined {
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
	public getRootDirectoryItems(transPairDirs: string[]): StatusItem[] {
		return transPairDirs.map((dirPath) => this.getDirectory(dirPath)).filter((item): item is StatusItem => !!item);
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
		const files = this.getFilesInDirectoryRecursive(dirPath);
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

	// ========== 操作 ==========

	/**
	 * ツリーを初期化
	 */
	public clear(): void {
		this.fileItemMap.clear();
		this.directoryItemMap.clear();
		this.unitItemMapWithPath.clear();
	}

	public dispose(): void {
		// EventEmitterの破棄
		this._onTreeChanged.dispose();
	}

	/**
	 * ツリーを構築
	 * @param files - StatusItemの配列
	 */
	public build(files: StatusItem[]): void {
		this.clear();

		for (const file of files) {
			this.addOrUpdateFile(file);
		}
	}

	/**
	 * FileItemを更新
	 */
	public addOrUpdateFile(fileItem: StatusItem): void {
		fileItem.isTranslating = false; // 翻訳中フラグをリセット
		if (fileItem.children) {
			fileItem.isTranslating = fileItem.children.some((file) => file.isTranslating === true);
		}
		if (fileItem.type === StatusItemType.File && fileItem.filePath) {
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
					if (unit.unitHash) {
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
			}

			// ディレクトリ更新
			this.addOrUpdateDirectory(fileItem);
		}
	}

	public updateFilePartial(filePath: string, updates: Partial<StatusItem>): StatusItem | undefined {
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
	 * UnitItemを部分更新
	 */
	public updateUnit(filePath: string, unitHash: string, updates: Partial<StatusItem>): StatusItem | undefined {
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
	private addOrUpdateDirectory(fileItem: StatusItem): void {
		if (!fileItem.filePath) return;

		const dirPath = path.dirname(fileItem.filePath);
		let directoryItem = this.directoryItemMap.get(dirPath);

		if (directoryItem) {
			// 既存のディレクトリStatusItemを更新
			if (!directoryItem.children) {
				directoryItem.children = [];
			}

			const index = directoryItem.children.findIndex((f) => f.filePath === fileItem.filePath);
			if (index >= 0) {
				Object.assign(directoryItem.children[index], fileItem);
			} else {
				directoryItem.children.push(fileItem);
			}

			directoryItem.collapsibleState =
				directoryItem.children && directoryItem.children.length > 0
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None;

			directoryItem.status = this.determineMergedStatus(directoryItem.children);

			// ディレクトリのisTranslatingフラグを決定
			directoryItem.isTranslating = directoryItem.children.some((file) => file.isTranslating === true);

			// ディレクトリのラベルを更新
			const totalUnits = directoryItem.children.reduce((sum, file) => sum + (file.totalUnits ?? 0), 0);
			const translatedUnits = directoryItem.children.reduce((sum, file) => sum + (file.translatedUnits ?? 0), 0);
			const dirName = path.basename(directoryItem.directoryPath || "") || directoryItem.directoryPath || "";
			directoryItem.label =
				directoryItem.status === Status.Source
					? `${dirName} (source)`
					: `${dirName} (${translatedUnits}/${totalUnits})`;

			directoryItem.totalUnits = totalUnits;
			directoryItem.translatedUnits = translatedUnits;
			this._onTreeChanged.fire(directoryItem);
		} else {
			// 新しいディレクトリStatusItemを作成
			directoryItem = this.createDirectoryStatusItem(dirPath, [fileItem]);
			this.directoryItemMap.set(dirPath, directoryItem);
			this._onTreeChanged.fire(directoryItem);
		}
	}

	/**
	 * ディレクトリStatusItemを作成
	 */
	private createDirectoryStatusItem(dirPath: string, files: StatusItem[]): StatusItem {
		const dirName = path.basename(dirPath) || dirPath;
		const totalUnits = files.reduce((sum, file) => sum + (file.totalUnits ?? 0), 0);
		const translatedUnits = files.reduce((sum, file) => sum + (file.translatedUnits ?? 0), 0);

		// ディレクトリの全体ステータスを決定
		const status = this.determineMergedStatus(files);

		// ディレクトリのisTranslatingフラグを決定
		const isTranslating = files.some((file) => file.isTranslating === true);

		// sourceディレクトリの場合は翻訳ユニット数を表示しない
		const label = status === Status.Source ? `${dirName}` : `${dirName} (${translatedUnits}/${totalUnits})`;

		return {
			type: StatusItemType.Directory,
			label,
			directoryPath: dirPath,
			status,
			isTranslating,
			contextValue: "mdaitDirectory",
			children: [...files], // ファイルのコピーを保持
			totalUnits,
			translatedUnits,
			collapsibleState:
				files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
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
	private determineMergedStatus(files: StatusItem[]): Status {
		if (files.length === 0) return Status.Unknown;

		const hasError = files.some((f) => f.status === Status.Error);
		if (hasError) return Status.Error;

		const allSource = files.every((f) => f.status === Status.Source || f.status === Status.Empty);
		if (allSource) return Status.Source;

		const totalUnits = files.reduce((sum, f) => sum + (f.totalUnits ?? 0), 0);
		const translatedUnits = files.reduce((sum, f) => sum + (f.translatedUnits ?? 0), 0);

		if (totalUnits === 0) return Status.Unknown;
		if (translatedUnits === totalUnits) return Status.Translated;
		return Status.NeedsTranslation;
	}
}
