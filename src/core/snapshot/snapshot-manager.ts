import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureMdaitDir } from "../../utils/mdait-dir";
import { decodeSnapshot, encodeSnapshot } from "./snapshot-encoder";

/**
 * スナップショットマネージャー
 * ユニットコンテンツのスナップショットを`.mdait/snapshot`ファイルで管理
 */
export class SnapshotManager {
	private static instance: SnapshotManager;

	/** インメモリキャッシュ: hash -> content */
	private cache = new Map<string, string>();

	/** バッチ書き込み用バッファ: hash -> encoded content */
	private writeBuffer = new Map<string, string>();

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

		// 既存のスナップショットを読み込み
		const existingSnapshots = await this.loadAllSnapshots();

		// バッファの内容をマージ（重複は上書き）
		for (const [hash, encoded] of this.writeBuffer) {
			existingSnapshots.set(hash, encoded);
		}

		// ファイルに書き込み
		const lines: string[] = [];
		for (const [hash, encoded] of existingSnapshots) {
			lines.push(`${hash} ${encoded}`);
		}

		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(lines.join("\n")));

		// バッファをクリア
		this.writeBuffer.clear();
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

		// ファイルから読み込み
		const content = await this.loadFromFile(hash);
		if (content) {
			this.cache.set(hash, content);
		}
		return content;
	}

	/**
	 * ファイルからスナップショットを読み込み
	 */
	private async loadFromFile(hash: string): Promise<string | null> {
		const filePath = this.getSnapshotFilePath();
		if (!filePath || !fs.existsSync(filePath)) {
			return null;
		}

		try {
			const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			const lines = new TextDecoder().decode(fileContent).split("\n");

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				const spaceIndex = trimmed.indexOf(" ");
				if (spaceIndex === -1) continue;

				const lineHash = trimmed.substring(0, spaceIndex);
				if (lineHash === hash) {
					const encoded = trimmed.substring(spaceIndex + 1);
					return decodeSnapshot(encoded);
				}
			}
		} catch (error) {
			console.warn(`Failed to load snapshot for hash ${hash}:`, error);
		}

		return null;
	}

	/**
	 * すべてのスナップショットを読み込み
	 * @returns hash -> encoded content のMap
	 */
	private async loadAllSnapshots(): Promise<Map<string, string>> {
		const snapshots = new Map<string, string>();
		const filePath = this.getSnapshotFilePath();

		if (!filePath || !fs.existsSync(filePath)) {
			return snapshots;
		}

		try {
			const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			const lines = new TextDecoder().decode(fileContent).split("\n");

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				const spaceIndex = trimmed.indexOf(" ");
				if (spaceIndex === -1) continue;

				const hash = trimmed.substring(0, spaceIndex);
				const encoded = trimmed.substring(spaceIndex + 1);
				snapshots.set(hash, encoded);
			}
		} catch (error) {
			console.warn("Failed to load all snapshots:", error);
		}

		return snapshots;
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

		// 全スナップショットを読み込み
		const allSnapshots = await this.loadAllSnapshots();

		// アクティブなもののみ残す
		const filteredSnapshots = new Map<string, string>();
		for (const [hash, encoded] of allSnapshots) {
			if (activeHashes.has(hash)) {
				filteredSnapshots.set(hash, encoded);
			}
		}

		// キャッシュも更新
		for (const hash of this.cache.keys()) {
			if (!activeHashes.has(hash)) {
				this.cache.delete(hash);
			}
		}

		// ファイルに書き込み
		const lines: string[] = [];
		for (const [hash, encoded] of filteredSnapshots) {
			lines.push(`${hash} ${encoded}`);
		}

		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(lines.join("\n")));

		console.log(`GC completed: ${allSnapshots.size} -> ${filteredSnapshots.size} snapshots`);
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
	}
}
