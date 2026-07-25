import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import type { StatusCollectorPort } from "./status-collector-port";
import {
	type DirectoryStatusItem,
	type FileStatusItem,
	Status,
	type StatusItem,
	type UnitStatusItem,
} from "./status-item";
import type { StatusItemType } from "./status-item";
import { StatusItemTree } from "./status-item-tree";

/** ツリー変更通知を束ねる既定の待ち時間（ミリ秒） */
const DEFAULT_NOTIFY_DEBOUNCE_MS = 80;

/**
 * 変更が途切れずに続く場合でも、この時間を超えたら必ず通知する上限（ミリ秒）。
 * これが無いと、ディレクトリ一括 sync のように短い間隔で更新が続く処理の最中は
 * 通知が一度も出ず、終わるまでツリーが凍って見える。
 */
const DEFAULT_NOTIFY_MAX_WAIT_MS = 300;

/**
 * statusItemTreeに全StatusItemをツリーとして保持し、状態管理を行います。
 * 全コマンド・UIから同一インスタンスにアクセスし、ステータスの管理およびUIの更新を担当します。
 *
 * 更新通知の方針（ADR-260724-01）:
 * StatusItemTree からの「変更あり」シグナルをデバウンスで束ね、ツリー全体の再描画を
 * 1回だけ通知する。どのノードを描き直すかは判定しない。部分通知は「要対応ノードだけ
 * 更新されない」不具合の発生源であったため廃止した。
 *
 * デバウンスは束ねるためのものであり、遅らせるためのものではない。最後の変更から必ず
 * 1回通知されること（取りこぼさないこと）が本方式の前提である。
 */
export class StatusManager {
	// Event
	private readonly _onStatusTreeChanged = new vscode.EventEmitter<void>();
	public readonly onStatusTreeChanged: vscode.Event<void> =
		this._onStatusTreeChanged.event;

	// Singletonインスタンス
	private static instance: StatusManager;

	// StatusItemTree（ファーストクラスコレクション）
	private statusItemTree: StatusItemTree;

	// ツリー変更通知のデバウンス
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private notifyDebounceMs = DEFAULT_NOTIFY_DEBOUNCE_MS;
	private notifyMaxWaitMs = DEFAULT_NOTIFY_MAX_WAIT_MS;
	/** 保留中の通知のうち、最初の変更が起きた時刻（maxWait の起点） */
	private pendingSince: number | undefined;

	// StatusItemTree の購読（インスタンス差し替え時に張り直す）
	private treeSubscription: vscode.Disposable | undefined;

	// StatusCollectorPort（DI注入。ファイル状況の収集・更新を担当）
	private statusCollector: StatusCollectorPort | undefined;

	// 設定情報
	private config: Configuration;

	// 初期化済みフラグ
	private initialized = false;

	/**
	 * Constructor (private)
	 */
	private constructor() {
		this.config = Configuration.getInstance();
		this.statusItemTree = new StatusItemTree();
		this.subscribeToTree();
	}

	/**
	 * 現在の StatusItemTree の変更シグナルを購読する（インスタンス差し替え時に張り直す）。
	 * 構築時から購読しておくことで、全体再構築より前の変更も通知が取りこぼされない。
	 */
	private subscribeToTree(): void {
		this.treeSubscription?.dispose();
		this.treeSubscription = this.statusItemTree.onTreeChanged(() => {
			this.scheduleNotify();
		});
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
	 * 通知デバウンスの待ち時間を設定する（テスト用。0 で即時通知）
	 * @param ms 束ねる待ち時間
	 * @param maxWaitMs 変更が続く場合でも必ず通知する上限（省略時は既定値を維持）
	 */
	public setNotifyDebounceMs(ms: number, maxWaitMs?: number): void {
		this.notifyDebounceMs = Math.max(0, ms);
		if (maxWaitMs !== undefined) {
			this.notifyMaxWaitMs = Math.max(0, maxWaitMs);
		}
	}

	/**
	 * 保留中の通知があれば即座に発行する（テスト用）
	 */
	public flushPendingNotification(): void {
		if (this.notifyTimer) {
			this.fireNotifyNow();
		}
	}

	/**
	 * ツリー変更通知を予約する。待ち時間内の複数変更は1回にまとめられ、
	 * 最後の変更から必ず1回発行される。
	 *
	 * 変更が待ち時間より短い間隔で続く場合も、最初の変更から maxWait を超えたら発行する。
	 * これが無いと一括処理中はツリーが凍って見える。
	 */
	private scheduleNotify(): void {
		if (this.notifyDebounceMs === 0) {
			this._onStatusTreeChanged.fire();
			return;
		}

		const now = Date.now();
		if (this.pendingSince === undefined) {
			this.pendingSince = now;
		} else if (now - this.pendingSince >= this.notifyMaxWaitMs) {
			// 上限に達した: 束ねるのをやめて即座に発行する
			this.fireNotifyNow();
			return;
		}

		if (this.notifyTimer) {
			clearTimeout(this.notifyTimer);
		}
		const remainingMaxWait = Math.max(
			0,
			this.notifyMaxWaitMs - (now - this.pendingSince),
		);
		this.notifyTimer = setTimeout(
			() => this.fireNotifyNow(),
			Math.min(this.notifyDebounceMs, remainingMaxWait),
		);
	}

	/**
	 * 保留状態をクリアして通知を発行する
	 */
	private fireNotifyNow(): void {
		if (this.notifyTimer) {
			clearTimeout(this.notifyTimer);
			this.notifyTimer = undefined;
		}
		this.pendingSince = undefined;
		this._onStatusTreeChanged.fire();
	}

	/**
	 * setCollector
	 * StatusCollectorPort実装をDI注入する。activate時に呼び出す。
	 */
	public setCollector(collector: StatusCollectorPort): void {
		this.statusCollector = collector;
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
			if (!this.statusCollector) {
				console.warn(
					"StatusManager: buildStatusItemTree() - collector not set, skipping",
				);
				return;
			}
			this.initialize();
			// 新しいツリーを取得してから差し替える。
			// 先に clear/dispose すると、収集が失敗したときに「空にされた上に
			// EventEmitter が破棄済み」の壊れたツリーだけが残る。
			const newTree = await this.statusCollector.buildStatusItemTree();
			const previousTree = this.statusItemTree;
			this.statusItemTree = newTree;
			previousTree?.clear();
			previousTree?.dispose();
			// 差し替え前のツリーへの購読を破棄してから張り直す
			this.subscribeToTree();

			// 全体再構築の完了を即時通知する（保留中の予約は破棄して重複を防ぐ）
			this.fireNotifyNow();

			const endTime = performance.now();
			console.log(
				`StatusManager: buildAllStatusItem() - finish (${Math.round(endTime - startTime)}ms)`,
			);
			return;
		} catch (error) {
			console.error("StatusManager: buildAllStatusItem() - error", error);
			throw error;
		}
	}

	/**
	 * updateFileStatus
	 * 指定ファイルのステータスを再構築し、イベント通知。
	 * ファイルが既に存在しない場合はツリーから取り除く（削除・リネームの自己修復）。
	 */
	public async refreshFileStatus(filePath: string): Promise<void> {
		try {
			if (!this.statusCollector) {
				console.warn(
					"StatusManager: refreshFileStatus() - collector not set, skipping",
				);
				return;
			}

			if (!this.statusCollector.fileExists(filePath)) {
				if (this.statusItemTree.removeFile(filePath)) {
					Logger.getInstance().debug(
						"status",
						"Removed missing file from status tree",
						{ filePath },
					);
				}
				return;
			}

			const newStatus = await this.statusCollector.collectFileStatus(filePath);

			// 該当ファイルのStatusItemを再構築
			this.statusItemTree.addOrUpdateFile(newStatus);
		} catch (error) {
			// エラーを握り潰さず Logger に出す（IPC structuredLogs / 出力チャネルに表出させ、
			// 「コマンドは成功扱いだが UI に最終状態が反映されない」事象を観測可能にする）
			const message = error instanceof Error ? error.message : String(error);
			Logger.getInstance().error(
				"status",
				`refreshFileStatus failed: ${filePath}`,
				{ error: message },
			);
			console.error(
				`StatusManager: refreshFileStatus() - Error: ${filePath}`,
				error,
			);
		}
	}

	/**
	 * changeFileStatus
	 * 指定ファイルのステータスを変更
	 */
	public async changeFileStatus(
		filePath: string,
		modifications: Partial<FileStatusItem>,
	): Promise<void> {
		try {
			this.statusItemTree.updateFilePartial(filePath, modifications);
		} catch (error) {
			console.error(
				`StatusManager: applyFileStatus() - error: ${filePath}`,
				error,
			);
		}
	}

	/**
	 * changeDirectoryStatus
	 * 指定ディレクトリのステータスを変更
	 */
	public async changeDirectoryStatus(
		directoryPath: string,
		modifications: Partial<DirectoryStatusItem>,
	): Promise<void> {
		try {
			this.statusItemTree.updateDirectoryPartial(directoryPath, modifications);
		} catch (error) {
			console.error(
				`StatusManager: changeDirectoryStatus() - error: ${directoryPath}`,
				error,
			);
		}
	}

	/**
	 * changeUnitStatus
	 * ユニットのステータスをmodificationsの値に変更
	 */
	public changeUnitStatus(
		unitHash: string,
		modifications: Partial<UnitStatusItem>,
		filePath: string,
	): void {
		try {
			this.statusItemTree.updateUnit(filePath, unitHash, modifications);
		} catch (error) {
			console.error(
				`StatusManager: updateUnitStatus() - error: ${unitHash}`,
				error,
			);
		}
	}

	/**
	 * エラー発生時のStatusItem更新
	 */
	public async changeFileStatusWithError(
		filePath: string,
		error: Error,
	): Promise<void> {
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
		if (this.notifyTimer) {
			clearTimeout(this.notifyTimer);
			this.notifyTimer = undefined;
		}
		this.pendingSince = undefined;
		this.treeSubscription?.dispose();
		this.treeSubscription = undefined;
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
