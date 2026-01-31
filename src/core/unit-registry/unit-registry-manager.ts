import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureMdaitDir } from "../../utils/mdait-dir";
import { decodeUnitRegistry, encodeUnitRegistry } from "./unit-registry-encoder";
import { UnitRegistryParseError, UnitRegistryStore } from "./unit-registry-store";

/**
 * ユニットレジストリマネージャー
 * ユニットコンテンツのレジストリを`.mdait/unit-registry`ファイルで管理
 *
 * CRC32ハッシュの先頭3桁（000〜fff）で区画化し、
 * 決定的な順序（バケット昇順＋エントリ昇順）で出力
 */
export class UnitRegistryManager {
	private static instance: UnitRegistryManager;

	/** インメモリキャッシュ: hash -> decoded content */
	private cache = new Map<string, string>();

	/** バッチ書き込み用バッファ: hash -> encoded content */
	private writeBuffer = new Map<string, string>();

	/** バケット化ストア（ファイル読み込み時に使用） */
	private store: UnitRegistryStore | null = null;

	/** ストアが読み込み済みかどうか */
	private storeLoaded = false;

	/** GC閾値（バイト） */
	private static readonly GC_THRESHOLD = 5 * 1024 * 1024; // 5MB

	private constructor() {}

	/**
	 * シングルトンインスタンスを取得
	 */
	static getInstance(): UnitRegistryManager {
		if (!UnitRegistryManager.instance) {
			UnitRegistryManager.instance = new UnitRegistryManager();
		}
		return UnitRegistryManager.instance;
	}

	/**
	 * テスト用にインスタンスをリセット
	 */
	static resetInstance(): void {
		UnitRegistryManager.instance = new UnitRegistryManager();
	}

	/**
	 * ユニットレジストリファイルのパスを取得
	 */
	private getUnitRegistryFilePath(): string | null {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return null;
		}
		return path.join(workspaceRoot, ".mdait", "unit-registry");
	}

	/**
	 * ユニットレジストリを保存（バッファに追加）
	 * @param hash ユニットのハッシュ
	 * @param content ユニットのコンテンツ
	 */
	saveUnitRegistry(hash: string, content: string): void {
		// キャッシュに追加
		this.cache.set(hash, content);

		// バッファにエンコード済みで追加
		const encoded = encodeUnitRegistry(content);
		this.writeBuffer.set(hash, encoded);
	}

	/**
	 * バッファ内のユニットレジストリを一括でファイルに書き込み
	 */
	async flushBuffer(): Promise<void> {
		if (this.writeBuffer.size === 0) {
			return;
		}

		// .mdaitディレクトリを初期化（.gitignoreも自動生成）
		const mdaitDir = await ensureMdaitDir();
		if (!mdaitDir) {
			console.warn("Workspace not found, cannot flush unit-registry");
			return;
		}

		const filePath = path.join(mdaitDir, "unit-registry");

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
	private async getOrLoadStore(): Promise<UnitRegistryStore> {
		if (this.store && this.storeLoaded) {
			return this.store;
		}

		this.store = new UnitRegistryStore();
		const filePath = this.getUnitRegistryFilePath();

		if (filePath && fs.existsSync(filePath)) {
			try {
				const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
				const content = new TextDecoder().decode(fileContent);
				this.store.parse(content);
			} catch (error) {
				if (error instanceof UnitRegistryParseError) {
					console.warn("Unit-registry file is in invalid format (possibly v1). Starting fresh:", error.message);
				} else {
					console.warn("Failed to load unit-registry file:", error);
				}
				// パース失敗時は空のストアで継続
				this.store = new UnitRegistryStore();
			}
		}

		this.storeLoaded = true;
		return this.store;
	}

	/**
	 * ユニットレジストリを読み込み
	 * @param hash ユニットのハッシュ
	 * @returns ユニットのコンテンツ、存在しない場合はnull
	 */
	async loadUnitRegistry(hash: string): Promise<string | null> {
		// キャッシュヒット
		if (this.cache.has(hash)) {
			return this.cache.get(hash) ?? null;
		}

		// ストアから読み込み
		const store = await this.getOrLoadStore();
		const encoded = store.get(hash);
		if (encoded) {
			const content = decodeUnitRegistry(encoded);
			this.cache.set(hash, content);
			return content;
		}

		return null;
	}

	/**
	 * 不要なユニットレジストリを削除（GC）
	 * @param activeHashes 現在使用中のハッシュセット
	 */
	async garbageCollect(activeHashes: Set<string>): Promise<void> {
		const filePath = this.getUnitRegistryFilePath();
		if (!filePath || !fs.existsSync(filePath)) {
			return;
		}

		// ファイルサイズチェック（閾値未満ならスキップ）
		const stats = fs.statSync(filePath);
		if (stats.size < UnitRegistryManager.GC_THRESHOLD) {
			return;
		}

		console.log(`Running unit-registry GC (file size: ${Math.round(stats.size / 1024)}KB)`);

		// ストアを取得
		const store = await this.getOrLoadStore();
		const beforeSize = store.size();

		// 初期エントリ（^[0-9a-f]{3}00000$）を保護対象に追加
		const protectedHashes = new Set(activeHashes);
		for (let i = 0; i < 4096; i++) {
			const bucketId = i.toString(16).padStart(3, "0");
			protectedHashes.add(`${bucketId}00000`);
		}

		// アクティブなもののみ残す
		store.retainOnly(protectedHashes);

		// キャッシュも更新
		for (const hash of this.cache.keys()) {
			if (!activeHashes.has(hash)) {
				this.cache.delete(hash);
			}
		}

		// 正規形でファイルに書き込み
		const content = store.serialize();
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(content));

		console.log(`GC completed: ${beforeSize} -> ${store.size()} unit-registry entries`);
	}

	/**
	 * ユニットレジストリファイルのサイズを取得
	 * @returns ファイルサイズ（バイト）、存在しない場合は0
	 */
	getUnitRegistryFileSize(): number {
		const filePath = this.getUnitRegistryFilePath();
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
