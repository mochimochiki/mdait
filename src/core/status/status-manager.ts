import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusCollector } from "./status-collector";
import { Status, type StatusItem } from "./status-item";
import type { StatusItemType } from "./status-item";
import { StatusItemTree } from "./status-item-tree";

/**
 * statusItemTreeに全StatusItemをツリーとして保持し、状態管理を行います。
 * 全コマンド・UIから同一インスタンスにアクセスし、ステータスの管理およびUIの更新を担当します。
 */
export class StatusManager {
	// Event
	private readonly _onStatusTreeChanged = new vscode.EventEmitter<StatusItem | undefined>();
	public readonly onStatusTreeChanged: vscode.Event<StatusItem | undefined> = this._onStatusTreeChanged.event;

	// Singletonインスタンス
	private static instance: StatusManager;

	// StatusItemTree（ファーストクラスコレクション）
	private statusItemTree: StatusItemTree;

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
		this.statusItemTree = new StatusItemTree();
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
	 * buildAllStatusItem
	 * [重い処理]
	 * 全ファイルをパースしてStatusItemツリーを再構築
	 * パフォーマンス負荷が高いため、初回実行時や保険的な再構築が必要な場合のみ使用
	 */
	public async buildStatusItemTree(): Promise<void> {
		console.log("StatusManager: buildAllStatusItem() - Parse all files");
		const startTime = performance.now();

		try {
			this.initialize();
			// StatusCollectorから直接StatusItemTreeを取得
			if (this.statusItemTree) {
				// 既存のツリーをクリア
				this.statusItemTree.clear();
				this.statusItemTree.dispose();
			}
			this.statusItemTree = await this.statusCollector.buildStatusItemTree();
			this.statusItemTree.onTreeChanged((item) => {
				this._onStatusTreeChanged.fire(item);
			});

			// イベントを発火（ツリー全体更新を通知、undefinedはツリー全体更新の意味）
			this._onStatusTreeChanged.fire(undefined);

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
	 * 指定ファイルのステータスを再構築し、イベント通知
	 */
	public async refreshFileStatus(filePath: string): Promise<void> {
		try {
			const newStatus = await this.statusCollector.collectFileStatus(filePath);

			// 該当ファイルのStatusItemを再構築
			this.statusItemTree.addOrUpdateFile(newStatus);
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
			this.statusItemTree.updateFilePartial(filePath, modifications);
		} catch (error) {
			console.error(`StatusManager: applyFileStatus() - error: ${filePath}`, error);
		}
	}

	/**
	 * changeDirectoryStatus
	 * 指定ディレクトリのステータスを変更
	 */
	public async changeDirectoryStatus(directoryPath: string, modifications: Partial<StatusItem>): Promise<void> {
		try {
			this.statusItemTree.updateDirectoryPartial(directoryPath, modifications);
		} catch (error) {
			console.error(`StatusManager: changeDirectoryStatus() - error: ${directoryPath}`, error);
		}
	}

	/**
	 * changeUnitStatus
	 * ユニットのステータスをmodificationsの値に変更
	 */
	public changeUnitStatus(unitHash: string, modifications: Partial<StatusItem>, filePath: string): void {
		try {
			this.statusItemTree.updateUnit(filePath, unitHash, modifications);
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

	/**
	 * リソースのクリーンアップ
	 * 拡張機能の無効化時に呼び出される
	 */
	public dispose(): void {
		this.statusItemTree.dispose();
		this._onStatusTreeChanged.dispose();

		// Singletonインスタンスをリセット（開発時のリロードに対応）
		// biome-ignore lint/suspicious/noExplicitAny: Singletonリセットのため必要
		StatusManager.instance = undefined as any;
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
