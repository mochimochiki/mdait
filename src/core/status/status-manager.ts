import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusCollector } from "./status-collector";
import { Status, type StatusItem } from "./status-item";
import { StatusItemType } from "./status-item";

/**
 * StatusTreeProviderの最小限のインターフェース（StatusManagerとの連携用）
 */
export interface IStatusTreeProvider {
	setFileStatuses(statuses: StatusItem[]): void;
	refreshFromStatusManager(): void;
	updateFileStatus(filePath: string, fileStatusItem: StatusItem): void;
	updateUnitStatus(unitHash: string, updates: Partial<StatusItem>, filePath: string): void;
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

	// 設定情報
	private config: Configuration;

	// 初期化済みフラグ
	private initialized = false;

	/**
	 * Constructor (private)
	 */
	private constructor() {
		this.statusCollector = new StatusCollector();
		this.config = Configuration.getInstance();
	}

	/**
	 * getInstance
	 * StatusManagerのシングルトンインスタンスを取得
	 */
	public static getInstance(): StatusManager {
		if (!StatusManager.instance) {
			StatusManager.instance = new StatusManager();
		}
		return StatusManager.instance;
	}

	/**
	 * setStatusTreeProvider
	 * StatusTreeProviderを登録
	 * extension.ts起動時に呼び出される
	 */
	public setStatusTreeProvider(provider: IStatusTreeProvider): void {
		this.statusTreeProvider = provider;
	}

	/**
	 * buildAllStatusItem
	 * [重い処理]
	 * 全ファイルをパースしてStatusItemツリーを再構築
	 * パフォーマンス負荷が高いため、初回実行時や保険的な再構築が必要な場合のみ使用
	 */
	public async buildAllStatusItem(): Promise<StatusItem[]> {
		console.log("StatusManager: buildAllStatusItem() - Parse all files");
		const startTime = performance.now();

		try {
			this.initialize();
			this.statusItemTree = await this.statusCollector.buildAllStatusItem();

			// StatusTreeProviderに全体更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.setFileStatuses(this.statusItemTree);
				this.statusTreeProvider.refreshFromStatusManager();
			}

			const endTime = performance.now();
			console.log(`StatusManager: buildAllStatusItem() - finish (${Math.round(endTime - startTime)}ms)`);
			return this.statusItemTree;
		} catch (error) {
			console.error("StatusManager: buildAllStatusItem() - error", error);
			throw error;
		}
	}

	/**
	 * updateFileStatus
	 * 指定ファイルのステータスを再構築し、StatusTreeProviderに更新を通知
	 */
	public async refreshFileStatus(filePath: string): Promise<void> {
		try {
			// 該当ファイルのStatusItemを再構築
			const item = this.getStatusItem(filePath);
			// Assignを使うことでStatusItemのインスタンス自体は保持しつつ、最新の状態に更新(代入してしまうとgetTreeItemで古い状態が返る可能性があるため)
			if (item) {
				Object.assign(item, await this.statusCollector.collectFileStatus(filePath));
			}

			// StatusTreeProviderに効率的な更新を通知
			if (this.statusTreeProvider) {
				if (item) {
					this.statusTreeProvider.updateFileStatus(filePath, item);
				}
			}
		} catch (error) {
			console.error(`StatusManager: updateFileStatus() - Error: ${filePath}`, error);
		}
	}

	/**
	 * changeFileStatus
	 * 指定ファイルのステータスを変更
	 */
	public async changeFileStatus(filePath: string, modifications: Partial<StatusItem>): Promise<void> {
		try {
			const item = this.getStatusItem(filePath);

			if (item) {
				Object.assign(item, modifications); // 更新項目を適用
				if (this.statusTreeProvider) {
					this.statusTreeProvider.updateFileStatus(filePath, item);
				}
			}
		} catch (error) {
			console.error(`StatusManager: applyFileStatus() - error: ${filePath}`, error);
		}
	}

	/**
	 * changeUnitStatus
	 * ユニットのステータスをmodificationsの値に変更
	 */
	public changeUnitStatus(unitHash: string, modifications: Partial<StatusItem>, filePath: string): void {
		try {
			const item = this.getUnitStatusItem(unitHash, filePath);
			if (item) {
				Object.assign(item, modifications); // 更新項目を適用
				if (this.statusTreeProvider) {
					this.statusTreeProvider.updateUnitStatus(unitHash, modifications, filePath);
				}
			}
		} catch (error) {
			console.error(`StatusManager: updateUnitStatus() - error: ${unitHash}`, error);
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
				status: Status.Error,
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
			console.error(`StatusManager: updateFileStatusWithError() - error: ${filePath}`, updateError);
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
	public getUnitStatusItem(hash: string, path?: string): StatusItem | undefined {
		return this.findFirstUnitByHash(this.statusItemTree, hash, path);
	}

	/**
	 * 指定fromHashに対応するユニットをStatusItemツリーから取得
	 */
	public getUnitStatusItemByFromHash(fromHash: string, path?: string): StatusItem | undefined {
		return this.findFirstUnitByFromHash(this.statusItemTree, fromHash, path);
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

	/**
	 * 初期化処理
	 * StatusCollectorの初期化と設定情報の読み込みを行う
	 */
	private async initialize() {
		this.config = Configuration.getInstance();
		this.initialized = true;
	}

	/**
	 * StatusItemツリー内でfromHashが一致するユニットを再帰的に検索
	 * path指定時はそのパス内のユニットのみを対象とする
	 */
	private findFirstUnitByFromHash(items: StatusItem[], fromHash: string, path?: string): StatusItem | undefined {
		if (path) {
			const item = this.getStatusItemInTree(items, path);
			if (item && item.type === StatusItemType.File && item.children) {
				return this.findFirstUnitByFromHash(item.children, fromHash);
			}
		}

		for (const item of items) {
			if (item.type === StatusItemType.Unit && item.fromHash === fromHash) {
				return item;
			}

			if (item.children) {
				const found = this.findFirstUnitByFromHash(item.children, fromHash, path);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	/**
	 * StatusItemツリー内でhashが一致するユニットを再帰的に検索
	 * path指定時はそのパス内のユニットのみを対象とする
	 */
	private findFirstUnitByHash(items: StatusItem[], unitHash: string, path?: string): StatusItem | undefined {
		if (path) {
			const item = this.getStatusItemInTree(items, path);
			if (item && item.type === StatusItemType.File && item.children) {
				return this.findFirstUnitByHash(item.children, unitHash);
			}
		}

		for (const item of items) {
			if (item.type === StatusItemType.Unit && item.unitHash === unitHash) {
				return item;
			}

			if (item.children) {
				const found = this.findFirstUnitByHash(item.children, unitHash, path);
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
				if (item.status === Status.Translated) {
					translatedUnits++;
				} else if (item.status === Status.Error) {
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
}
