import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusCollector } from "./status-collector";
import { Status, type StatusItem } from "./status-item";
import { StatusItemType } from "./status-item";
import { StatusItemTree } from "./status-item-tree";

/**
 * StatusTreeProviderの最小限のインターフェース（StatusManagerとの連携用）
 */
export interface IStatusTreeProvider {
	statusTreeChanged(): void;
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

	// StatusItemTree（ファーストクラスコレクション）
	private statusItemTree: StatusItemTree = new StatusItemTree();

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
	public async buildAllStatusItem(): Promise<void> {
		console.log("StatusManager: buildAllStatusItem() - Parse all files");
		const startTime = performance.now();

		try {
			this.initialize();
			// StatusCollectorから直接StatusItemTreeを取得
			this.statusItemTree = await this.statusCollector.buildAllStatusItem();

			// StatusTreeProviderに全体更新を通知
			if (this.statusTreeProvider) {
				this.statusTreeProvider.statusTreeChanged();
			}

			const endTime = performance.now();
			console.log(`StatusManager: buildAllStatusItem() - finish (${Math.round(endTime - startTime)}ms)`);
			return;
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
	public async changeFileStatusWithError(filePath: string, error: Error): Promise<void> {
		console.log(`StatusManager: changeFileStatusWithError() - ${filePath}`);
		await this.changeFileStatus(filePath, { errorMessage: error.message });
	}

	/**
	 * 指定ファイル/ディレクトリパスのStatusItemを取得
	 */
	public getStatusItem(path: string): StatusItem | undefined {
		return this.statusItemTree.findByPath(path);
	}

	/**
	 * 指定ハッシュのユニットをStatusItemツリーから取得
	 */
	public getUnitStatusItem(hash: string, path?: string): StatusItem | undefined {
		if (!path) {
			return this.statusItemTree.findFirstUnitByFromHashWithoutPath(hash);
		}
		return this.statusItemTree.findUnitByHash(hash, path);
	}

	/**
	 * 指定fromHashに対応するユニットをStatusItemツリーから取得
	 */
	public getUnitStatusItemByFromHash(fromHash: string, path?: string): StatusItem | undefined {
		if (!path) {
			return this.statusItemTree.findFirstUnitByFromHashWithoutPath(fromHash);
		}
		return this.statusItemTree.findUnitByFromHash(fromHash, path);
	}

	/**
	 * 指定ファイルパス内の未翻訳ユニット（needFlag付き）を取得
	 */
	public getUntranslatedUnits(filePath: string): StatusItem[] {
		return this.statusItemTree.getUntranslatedUnitsInFile(filePath);
	}

	/**
	 * StatusItemツリーを取得
	 */
	public getTreeFileStatusList(): StatusItem[] {
		return this.statusItemTree.getAllFiles();
	}

	/**
	 * StatusItemツリーから進捗情報を集計
	 */
	public aggregateProgress(): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		return this.statusItemTree.aggregateProgress();
	}

	/**
	 * 初期化済みか
	 */
	public isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * StatusItemTree インスタンスを取得（StatusTreeProviderでの活用のため）
	 */
	public getStatusItemTree(): StatusItemTree {
		return this.statusItemTree;
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
}
