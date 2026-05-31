/**
 * デバッグ専用: ステータスツリーの fire イベント発火履歴を記録するレコーダー。
 *
 * 目的:
 *   「コマンドは成功するがツリー表示が同期されない」事象を機械検出するため、
 *   _onTreeChanged / _onDidChangeTreeData の fire() が
 *   「いつ・どの引数で」呼ばれたかをタイムラインとして記録する。
 *
 * 本番安全性:
 *   enable() は DebugCommandHandler 構築時（= MDAIT_DEBUG_IPC 有効時）のみ呼ばれる。
 *   未有効時は record() / start() / stop() が即 return するため本番挙動は変わらない。
 */

import type { StatusItem, StatusItemType } from "../../core/status/status-item";

/** fire 発火元の種別 */
export type FireSource = "tree" | "provider";

/** 記録された 1 回の fire イベント */
export interface FireEvent {
	/** 通し番号（start() からの連番） */
	seq: number;
	/** 発火元 EventEmitter */
	source: FireSource;
	/** 通知対象の種別（undefined/null は全体更新） */
	kind: StatusItemType | "all";
	/** 通知対象のラベル（あれば） */
	label?: string;
	/** 通知対象のパス（file/directory/unit のとき） */
	path?: string;
	/** 記録時刻（ISO8601） */
	at: string;
}

export class DebugFireRecorder {
	private static instance: DebugFireRecorder | undefined;

	private enabled = false;
	private recording = false;
	private events: FireEvent[] = [];
	private seq = 0;

	private constructor() {}

	public static getInstance(): DebugFireRecorder {
		if (!DebugFireRecorder.instance) {
			DebugFireRecorder.instance = new DebugFireRecorder();
		}
		return DebugFireRecorder.instance;
	}

	/** デバッグIPCモードでのみ有効化する。未有効時は全操作が no-op。 */
	public enable(): void {
		this.enabled = true;
	}

	/** 計装を無効化する（主にテスト用。本番初期状態と同等）。 */
	public disable(): void {
		this.enabled = false;
		this.recording = false;
		this.events = [];
	}

	public isEnabled(): boolean {
		return this.enabled;
	}

	/** 記録開始（バッファをクリア） */
	public start(): void {
		if (!this.enabled) return;
		this.recording = true;
		this.events = [];
		this.seq = 0;
	}

	/** 記録停止し、収集したイベント列を返す */
	public stop(): FireEvent[] {
		if (!this.enabled) return [];
		this.recording = false;
		return this.events;
	}

	/**
	 * fire イベントを記録する。各 fire 呼び出し元から呼ばれる。
	 * @param source 発火元 EventEmitter
	 * @param item   fire の引数（undefined/null は全体更新）
	 */
	public record(source: FireSource, item: StatusItem | undefined | null): void {
		if (!this.enabled || !this.recording) return;

		const event: FireEvent = {
			seq: this.seq++,
			source,
			kind: item ? item.type : "all",
			at: new Date().toISOString(),
		};

		if (item) {
			event.label = item.label;
			if ("filePath" in item) {
				event.path = item.filePath;
			} else if ("directoryPath" in item) {
				event.path = item.directoryPath;
			}
		}

		this.events.push(event);
	}
}
