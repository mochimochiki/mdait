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
}

/**
 * StatusItemの一元管理を行うシングルトンクラス
 * 全コマンド・UIから同一インスタンスにアクセスし、リアルタイム更新を実現
 */
export class StatusManager {
	private static instance: StatusManager;
	private statusItems: StatusItem[] = [];
	private statusTreeProvider?: IStatusTreeProvider;
	private statusCollector: StatusCollector;
	private isInitialized = false;

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
	public async rebuildStatusItemAll(config: Configuration): Promise<StatusItem[]> {
		console.log("StatusManager: rebuildStatusItemAll() - 全ファイルパースを開始（重い処理）");
		const startTime = performance.now();

		try {
			this.statusItems = await this.statusCollector.rebuildStatusItemAll(config);
			this.isInitialized = true;

			// StatusTreeProviderに全体更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItems);
				this.statusTreeProvider.refreshFromStatusManager();
			}

			const endTime = performance.now();
			console.log(
				`StatusManager: rebuildStatusItemAll() - 完了 (${Math.round(endTime - startTime)}ms)`,
			);
			return this.statusItems;
		} catch (error) {
			console.error("StatusManager: rebuildStatusItemAll() - エラー", error);
			throw error;
		}
	}

	/**
	 * ファイル単位でStatusItemを更新（syncコマンド用）
	 */
	public async updateFileStatus(filePath: string): Promise<void> {
		console.log(`StatusManager: updateFileStatus() - ${filePath}`);

		try {
			// 該当ファイルのStatusItemを更新
			this.statusItems = await this.statusCollector.updateStatusItemOnFileChange(
				filePath,
				this.statusItems,
			);

			// StatusTreeProviderに更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItems);
				this.statusTreeProvider.refreshFromStatusManager();
			}
		} catch (error) {
			console.error(`StatusManager: updateFileStatus() - エラー: ${filePath}`, error);
		}
	}

	/**
	 * ユニット単位でStatusItemを更新（transコマンド用）
	 */
	public updateUnitStatus(unitHash: string, updates: Partial<StatusItem>): void {
		console.log(`StatusManager: updateUnitStatus() - ${unitHash}`);

		try {
			const updated = this.updateStatusItemInTree(this.statusItems, unitHash, updates);

			if (updated && this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItems);
				this.statusTreeProvider.refreshFromStatusManager();
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
			const existingIndex = this.statusItems.findIndex(
				(item) => item.type === StatusItemType.File && item.filePath === filePath,
			);

			if (existingIndex >= 0) {
				this.statusItems[existingIndex] = errorStatusItem;
			} else {
				this.statusItems.push(errorStatusItem);
			}

			// StatusTreeProviderに更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItems);
				this.statusTreeProvider.refreshFromStatusManager();
			}
		} catch (updateError) {
			console.error(
				`StatusManager: updateFileStatusWithError() - 更新エラー: ${filePath}`,
				updateError,
			);
		}
	}

	/**
	 * StatusItemツリーをfromHashで再帰検索し、一致するユニットを返す
	 */
	public findUnitsByFromHash(fromHash: string): StatusItem[] {
		return this.findUnitsByFromHashInTree(this.statusItems, fromHash);
	}

	/**
	 * StatusItemツリーをunitHashで再帰検索し、一致するユニットを返す
	 */
	public findUnitByHash(unitHash: string): StatusItem | undefined {
		return this.findUnitByHashInTree(this.statusItems, unitHash);
	}

	/**
	 * 指定ファイルパス内の未翻訳ユニット（needFlag付き）を取得
	 */
	public getUntranslatedUnits(filePath: string): StatusItem[] {
		return this.getUntranslatedUnitsInTree(this.statusItems, filePath);
	}

	/**
	 * StatusItemツリーから進捗情報を集計
	 */
	public aggregateProgress(): { totalUnits: number; translatedUnits: number; errorUnits: number } {
		return this.aggregateProgressInTree(this.statusItems);
	}

	/**
	 * 指定パス配下のStatusItemを再帰検索
	 */
	public findItemByPath(targetPath: string): StatusItem | undefined {
		return this.findItemByPathInTree(this.statusItems, targetPath);
	}

	/**
	 * エラー状態のアイテムを抽出
	 */
	public getErrorItems(): StatusItem[] {
		return this.getErrorItemsInTree(this.statusItems);
	}

	/**
	 * StatusItemツリーをフラットな配列に変換
	 */
	public flattenStatusItems(filterType?: StatusItemType): StatusItem[] {
		return this.flattenStatusItemsInTree(this.statusItems, filterType);
	}

	/**
	 * 現在のStatusItemを取得
	 */
	public getStatusItems(): StatusItem[] {
		return this.statusItems;
	}

	/**
	 * 初期化済みかどうかを確認
	 */
	public isStatusInitialized(): boolean {
		return this.isInitialized;
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

	private findItemByPathInTree(items: StatusItem[], targetPath: string): StatusItem | undefined {
		for (const item of items) {
			if (
				(item.type === StatusItemType.Directory && item.directoryPath === targetPath) ||
				(item.type === StatusItemType.File && item.filePath === targetPath)
			) {
				return item;
			}

			if (item.children) {
				const found = this.findItemByPathInTree(item.children, targetPath);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	private getErrorItemsInTree(items: StatusItem[]): StatusItem[] {
		const results: StatusItem[] = [];

		for (const item of items) {
			if (item.status === "error" || item.hasParseError) {
				results.push(item);
			}

			if (item.children) {
				results.push(...this.getErrorItemsInTree(item.children));
			}
		}

		return results;
	}

	private flattenStatusItemsInTree(items: StatusItem[], filterType?: StatusItemType): StatusItem[] {
		const results: StatusItem[] = [];

		for (const item of items) {
			if (!filterType || item.type === filterType) {
				results.push(item);
			}

			if (item.children) {
				results.push(...this.flattenStatusItemsInTree(item.children, filterType));
			}
		}

		return results;
	}

	private updateStatusItemInTree(
		items: StatusItem[],
		targetHash: string,
		updates: Partial<StatusItem>,
	): boolean {
		for (const item of items) {
			if (item.type === StatusItemType.Unit && item.unitHash === targetHash) {
				Object.assign(item, updates);
				return true;
			}

			if (item.children && this.updateStatusItemInTree(item.children, targetHash, updates)) {
				return true;
			}
		}

		return false;
	}
}
