import * as vscode from "vscode";
import type { Configuration } from "../../config/configuration";
import { StatusCollector } from "./status-collector";
import type { StatusItem, StatusType } from "./status-item";
import { StatusItemType } from "./status-item";

/**
 * StatusTreeProviderの最小限のインターフェース（StatusManagerとの連携用）
 */
export interface IStatusTreeProvider {
	setFileStatuses(statuses: StatusItem[]): void;
	refreshFromStatusManager(): void;
	updateFileStatus?(filePath: string, fileStatusItem: StatusItem): void;
	updateUnitStatus?(unitHash: string, updates: Partial<StatusItem>, filePath?: string): void;
}

/**
 * statusItemTreeに全StatusItemをツリーとして保持し、状態管理を行います。
 * 全コマンド・UIから同一インスタンスにアクセスし、ステータスの管理およびUIの更新を担当します。
 */
export class StatusManager {
	// Singletonインスタンス
	private static instance: StatusManager;

	// 現在のStatusItemツリー
	private statusItemTree: StatusItem[] = [];

	// UIのStatusTreeProvider
	private statusTreeProvider?: IStatusTreeProvider;

	// StatusCollectorインスタンス（ファイル状況の収集・更新を担当）
	private statusCollector: StatusCollector;

	// 初期化済みフラグ
	private initialized = false;

	/**
	 * コンストラクタはプライベートにしてシングルトンを実現
	 * StatusCollectorの初期化もここで行う
	 */
	private constructor() {
		this.statusCollector = new StatusCollector();
	}

	/**
	 * StatusManagerのシングルトンインスタンスを取得
	 */
	public static getInstance(): StatusManager {
		if (!StatusManager.instance) {
			StatusManager.instance = new StatusManager();
		}
		return StatusManager.instance;
	}

	/**
	 * StatusTreeProviderを登録
	 * extension.ts起動時に呼び出される
	 */
	public setStatusTreeProvider(provider: IStatusTreeProvider): void {
		this.statusTreeProvider = provider;
	}

	/**
	 * 【重い処理】全ファイルをパースしてStatusItemツリーを再構築
	 * パフォーマンス負荷が高いため、初回実行時や保険的な再構築が必要な場合のみ使用
	 */
	public async buildAllStatusItem(config: Configuration): Promise<StatusItem[]> {
		console.log("StatusManager: rebuildStatusItemAll() - 全ファイルパースを開始（重い処理）");
		const startTime = performance.now();

		try {
			this.statusItemTree = await this.statusCollector.buildAllStatusItem(config);
			this.initialized = true;

			// StatusTreeProviderに全体更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItemTree);
				this.statusTreeProvider.refreshFromStatusManager();
			}

			const endTime = performance.now();
			console.log(`StatusManager: rebuildStatusItemAll() - 完了 (${Math.round(endTime - startTime)}ms)`);
			return this.statusItemTree;
		} catch (error) {
			console.error("StatusManager: rebuildStatusItemAll() - エラー", error);
			throw error;
		}
	}

	/**
	 * ファイル単位でStatusItemを更新
	 * （syncコマンドで利用）
	 */
	public async updateFileStatus(filePath: string, config: Configuration): Promise<void> {
		console.log(`StatusManager: updateFileStatus() - ${filePath}`);

		try {
			// 該当ファイルのStatusItemを再構築
			this.statusItemTree = await this.statusCollector.retrieveUpdatedStatus(filePath, this.statusItemTree, config);

			// StatusTreeProviderに効率的な更新を通知
			if (this.statusTreeProvider) {
				// 部分更新機能がある場合は部分更新を使用
				if (this.statusTreeProvider.updateFileStatus) {
					const updatedFileItem = this.getStatusItem(filePath);
					if (updatedFileItem) {
						this.statusTreeProvider.updateFileStatus(filePath, updatedFileItem);
						return;
					}
				}

				// フォールバック：全体更新
				this.statusTreeProvider.setFileStatuses(this.statusItemTree);
				this.statusTreeProvider.refreshFromStatusManager();
			}
		} catch (error) {
			console.error(`StatusManager: updateFileStatus() - エラー: ${filePath}`, error);
		}
	}

	/**
	 * ユニット単位でStatusItemを更新（transコマンド用）
	 *
	 * @param unitHash 更新対象ユニットのハッシュ値
	 * @param updates 更新する項目（部分更新）
	 * @param filePath 対象ファイルパス（指定時は該当ファイル内のユニットのみ更新）
	 */
	public updateUnitStatus(unitHash: string, updates: Partial<StatusItem>, filePath?: string): void {
		console.log(`StatusManager: updateUnitStatus() - ${unitHash}${filePath ? ` in ${filePath}` : ""}`);

		try {
			const updated = this.updateStatusItemInTree(this.statusItemTree, unitHash, updates, filePath);

			if (updated && this.statusTreeProvider) {
				// 部分更新機能がある場合は部分更新を使用
				if (this.statusTreeProvider.updateUnitStatus && filePath) {
					this.statusTreeProvider.updateUnitStatus(unitHash, updates, filePath);
				} else {
					// フォールバック：全体更新
					this.statusTreeProvider.setFileStatuses(this.statusItemTree);
					this.statusTreeProvider.refreshFromStatusManager();
				}
			}
		} catch (error) {
			console.error(`StatusManager: updateUnitStatus() - エラー: ${unitHash}`, error);
		}
	}

	/**
	 * エラー発生時のStatusItem更新
	 */
	public async updateFileStatusWithError(filePath: string, error: Error): Promise<void> {
		console.log(`StatusManager: updateFileStatusWithError() - ${filePath}`);

		try {
			// エラー状態のStatusItemを作成
			const fileName = filePath.split(/[/\\]/).pop() || "";
			const errorStatusItem: StatusItem = {
				type: StatusItemType.File,
				label: fileName,
				status: "error",
				filePath,
				fileName,
				hasParseError: true,
				errorMessage: error.message,
				contextValue: "mdaitFile",
				collapsibleState: vscode.TreeItemCollapsibleState.None,
			};

			// 既存のStatusItemを更新または追加
			const existingIndex = this.statusItemTree.findIndex(
				(item) => item.type === StatusItemType.File && item.filePath === filePath,
			);

			if (existingIndex >= 0) {
				this.statusItemTree[existingIndex] = errorStatusItem;
			} else {
				this.statusItemTree.push(errorStatusItem);
			}

			// StatusTreeProviderに更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItemTree);
				this.statusTreeProvider.refreshFromStatusManager();
			}
		} catch (updateError) {
			console.error(`StatusManager: updateFileStatusWithError() - 更新エラー: ${filePath}`, updateError);
		}
	}

	/**
	 * 指定ファイル/ディレクトリパスのStatusItemを取得
	 */
	public getStatusItem(path: string): StatusItem | undefined {
		return this.getStatusItemInTree(this.statusItemTree, path);
	}

	/**
	 * 指定ハッシュのユニットをStatusItemツリーから取得
	 */
	public getUnitStatusItem(hash: string): StatusItem | undefined {
		return this.findUnitByHashInTree(this.statusItemTree, hash);
	}

	/**
	 * 指定fromHashに対応するユニットをStatusItemツリーから取得
	 */
	public getUnitStatusItemByFromHash(fromHash: string): StatusItem[] {
		return this.findUnitsByFromHashInTree(this.statusItemTree, fromHash);
	}

	/**
	 * 指定ファイルパス内の未翻訳ユニット（needFlag付き）を取得
	 */
	public getUntranslatedUnits(filePath: string): StatusItem[] {
		return this.getUntranslatedUnitsInTree(this.statusItemTree, filePath);
	}

	/**
	 * StatusItemツリーを取得
	 */
	public getStatusItemTree(): StatusItem[] {
		return this.statusItemTree;
	}

	/**
	 * StatusItemツリーから進捗情報を集計
	 */
	public aggregateProgress(): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		return this.aggregateProgressInTree(this.statusItemTree);
	}

	/**
	 * 初期化済みか
	 */
	public isInitialized(): boolean {
		return this.initialized;
	}

	// ========== 内部ユーティリティメソッド ==========

	private findUnitsByFromHashInTree(items: StatusItem[], fromHash: string): StatusItem[] {
		const results: StatusItem[] = [];

		for (const item of items) {
			if (item.type === StatusItemType.Unit && item.fromHash === fromHash) {
				results.push(item);
			}

			if (item.children) {
				results.push(...this.findUnitsByFromHashInTree(item.children, fromHash));
			}
		}

		return results;
	}

	private findUnitByHashInTree(items: StatusItem[], unitHash: string): StatusItem | undefined {
		for (const item of items) {
			if (item.type === StatusItemType.Unit && item.unitHash === unitHash) {
				return item;
			}

			if (item.children) {
				const found = this.findUnitByHashInTree(item.children, unitHash);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	private getUntranslatedUnitsInTree(items: StatusItem[], filePath: string): StatusItem[] {
		const results: StatusItem[] = [];

		for (const item of items) {
			if (item.type === StatusItemType.File && item.filePath === filePath && item.children) {
				for (const child of item.children) {
					if (child.type === StatusItemType.Unit && child.needFlag) {
						results.push(child);
					}
				}
			}

			if (item.children) {
				results.push(...this.getUntranslatedUnitsInTree(item.children, filePath));
			}
		}

		return results;
	}

	private aggregateProgressInTree(items: StatusItem[]): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		let totalUnits = 0;
		let translatedUnits = 0;
		let errorUnits = 0;

		for (const item of items) {
			if (item.type === StatusItemType.Unit) {
				totalUnits++;
				if (item.status === "translated") {
					translatedUnits++;
				} else if (item.status === "error") {
					errorUnits++;
				}
			}

			if (item.children) {
				const childProgress = this.aggregateProgressInTree(item.children);
				totalUnits += childProgress.totalUnits;
				translatedUnits += childProgress.translatedUnits;
				errorUnits += childProgress.errorUnits;
			}
		}

		return { totalUnits, translatedUnits, errorUnits };
	}

	private getStatusItemInTree(tree: StatusItem[], path: string): StatusItem | undefined {
		for (const item of tree) {
			if (
				(item.type === StatusItemType.Directory && item.directoryPath === path) ||
				(item.type === StatusItemType.File && item.filePath === path)
			) {
				return item;
			}

			if (item.children) {
				const found = this.getStatusItemInTree(item.children, path);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	/**
	 * StatusItemツリー内で指定ハッシュと一致するユニットを再帰的に検索・更新
	 *
	 * ファイルパスが指定された場合は、該当ファイル内のユニットのみを更新し、
	 * 同一ハッシュでも他ファイルのユニットは更新しない（適切な翻訳管理）
	 *
	 * @param items 検索対象のStatusItemツリー
	 * @param targetHash 更新対象ユニットのハッシュ値
	 * @param updates 更新する項目（部分更新）
	 * @param targetFilePath 対象ファイルパス（指定時は該当ファイル内のみ更新）
	 * @param currentFilePath 現在処理中のファイルパス（内部処理用）
	 * @returns 1つでも更新があった場合true、なければfalse
	 *
	 * @example
	 * // 特定ファイル内のユニットのみ翻訳完了として更新
	 * updateStatusItemInTree(statusItems, "3f7c8a1b", {
	 *   status: "translated",
	 *   needFlag: undefined
	 * }, "/path/to/file.md");
	 */
	private updateStatusItemInTree(
		items: StatusItem[],
		targetHash: string,
		updates: Partial<StatusItem>,
		targetFilePath?: string,
		currentFilePath?: string,
	): boolean {
		let updated = false;

		for (const item of items) {
			let contextFilePath = currentFilePath;

			// ファイルアイテムの場合、コンテキストを更新
			if (item.type === StatusItemType.File) {
				contextFilePath = item.filePath;

				// ファイルパス制約がある場合、対象ファイル以外はスキップ
				if (targetFilePath && item.filePath !== targetFilePath) {
					continue;
				}
			}

			// ユニットタイプで、かつハッシュが一致する場合に更新
			if (item.type === StatusItemType.Unit && item.unitHash === targetHash) {
				// ファイルパス制約がある場合は、現在のファイルコンテキストをチェック
				if (targetFilePath && contextFilePath !== targetFilePath) {
					continue; // 対象ファイル外のユニットはスキップ
				}

				Object.assign(item, updates);
				updated = true;
			}

			// 子要素が存在する場合は再帰的に検索・更新
			if (item.children) {
				const childUpdated = this.updateStatusItemInTree(
					item.children,
					targetHash,
					updates,
					targetFilePath,
					contextFilePath,
				);
				updated = updated || childUpdated; // 論理OR演算で更新フラグを集約
			}
		}

		return updated;
	}
}
