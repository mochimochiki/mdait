import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureMdaitDir } from "../../utils/mdait-dir";
import { decodeSnapshot, encodeSnapshot } from "./snapshot-encoder";
import { SnapshotParseError, SnapshotStore } from "./snapshot-store";

/**
 * スナップショットマネージャー
 * ユニットコンテンツのスナップショットを`.mdait/snapshot`ファイルで管理
 *
 * CRC32ハッシュの先頭3桁（000〜fff）で区画化し、
 * 決定的な順序（バケット昇順＋エントリ昇順）で出力
 */
export class SnapshotManager {
	private static instance: SnapshotManager;

	/** インメモリキャッシュ: hash -> decoded content */
	private cache = new Map<string, string>();

	/** バッチ書き込み用バッファ: hash -> encoded content */
	private writeBuffer = new Map<string, string>();

	/** バケット化ストア（ファイル読み込み時に使用） */
	private store: SnapshotStore | null = null;

	/** ストアが読み込み済みかどうか */
	private storeLoaded = false;

	/** GC閾値（バイト） */
	private static readonly GC_THRESHOLD = 5 * 1024 * 1024; // 5MB

	private constructor() {}

	/**
	 * シングルトンインスタンスを取得
	 */
	static getInstance(): SnapshotManager {
		if (!SnapshotManager.instance) {
			SnapshotManager.instance = new SnapshotManager();
		}
		return SnapshotManager.instance;
	}

	/**
	 * テスト用にインスタンスをリセット
	 */
	static resetInstance(): void {
		SnapshotManager.instance = new SnapshotManager();
	}

	/**
	 * スナップショットファイルのパスを取得
	 */
	private getSnapshotFilePath(): string | null {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return null;
		}
		return path.join(workspaceRoot, ".mdait", "snapshot");
	}

	/**
	 * スナップショットを保存（バッファに追加）
	 * @param hash ユニットのハッシュ
	 * @param content ユニットのコンテンツ
	 */
	saveSnapshot(hash: string, content: string): void {
		// キャッシュに追加
		this.cache.set(hash, content);

		// バッファにエンコード済みで追加
		const encoded = encodeSnapshot(content);
		this.writeBuffer.set(hash, encoded);
	}

	/**
	 * バッファ内のスナップショットを一括でファイルに書き込み
	 */
	async flushBuffer(): Promise<void> {
		if (this.writeBuffer.size === 0) {
			return;
		}

		// .mdaitディレクトリを初期化（.gitignoreも自動生成）
		const mdaitDir = await ensureMdaitDir();
		if (!mdaitDir) {
			console.warn("Workspace not found, cannot flush snapshots");
			return;
		}

		const filePath = path.join(mdaitDir, "snapshot");

		// ストアを取得または作成
		const store = await this.getOrLoadStore();

		// バッファの内容をマージ
		for (const [hash, encoded] of this.writeBuffer) {
			store.upsert(hash, encoded);
		}

		// 正規形でファイルに書き込み
		const content = store.serialize();
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(content));

		// バッファをクリア
		this.writeBuffer.clear();
	}

	/**
	 * ストアを取得または読み込み
	 */
	private async getOrLoadStore(): Promise<SnapshotStore> {
		if (this.store && this.storeLoaded) {
			return this.store;
		}

		this.store = new SnapshotStore();
		const filePath = this.getSnapshotFilePath();

		if (filePath && fs.existsSync(filePath)) {
			try {
				const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
				const content = new TextDecoder().decode(fileContent);
				this.store.parse(content);
			} catch (error) {
				if (error instanceof SnapshotParseError) {
					console.warn("Snapshot file is in invalid format (possibly v1). Starting fresh:", error.message);
				} else {
					console.warn("Failed to load snapshot file:", error);
				}
				// パース失敗時は空のストアで継続
				this.store = new SnapshotStore();
			}
		}

		this.storeLoaded = true;
		return this.store;
	}

	/**
	 * スナップショットを読み込み
	 * @param hash ユニットのハッシュ
	 * @returns ユニットのコンテンツ、存在しない場合はnull
	 */
	async loadSnapshot(hash: string): Promise<string | null> {
		// キャッシュヒット
		if (this.cache.has(hash)) {
			return this.cache.get(hash) ?? null;
		}

		// ストアから読み込み
		const store = await this.getOrLoadStore();
		const encoded = store.get(hash);
		if (encoded) {
			const content = decodeSnapshot(encoded);
			this.cache.set(hash, content);
			return content;
		}

		return null;
	}

	/**
	 * 不要なスナップショットを削除（GC）
	 * @param activeHashes 現在使用中のハッシュセット
	 */
	async garbageCollect(activeHashes: Set<string>): Promise<void> {
		const filePath = this.getSnapshotFilePath();
		if (!filePath || !fs.existsSync(filePath)) {
			return;
		}

		// ファイルサイズチェック（閾値未満ならスキップ）
		const stats = fs.statSync(filePath);
		if (stats.size < SnapshotManager.GC_THRESHOLD) {
			return;
		}

		console.log(`Running snapshot GC (file size: ${Math.round(stats.size / 1024)}KB)`);

		// ストアを取得
		const store = await this.getOrLoadStore();
		const beforeSize = store.size();

		// アクティブなもののみ残す
		store.retainOnly(activeHashes);

		// キャッシュも更新
		for (const hash of this.cache.keys()) {
			if (!activeHashes.has(hash)) {
				this.cache.delete(hash);
			}
		}

		// 正規形でファイルに書き込み
		const content = store.serialize();
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(content));

		console.log(`GC completed: ${beforeSize} -> ${store.size()} snapshots`);
	}

	/**
	 * スナップショットファイルのサイズを取得
	 * @returns ファイルサイズ（バイト）、存在しない場合は0
	 */
	getSnapshotFileSize(): number {
		const filePath = this.getSnapshotFilePath();
		if (!filePath || !fs.existsSync(filePath)) {
			return 0;
		}
		return fs.statSync(filePath).size;
	}

	/**
	 * キャッシュをクリア（テスト用）
	 */
	clearCache(): void {
		this.cache.clear();
		this.writeBuffer.clear();
		this.store = null;
		this.storeLoaded = false;
	}
}
