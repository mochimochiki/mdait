import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import {
	decodeUnitRegistry,
	encodeUnitRegistry,
} from "./unit-registry-encoder";
import {
	UnitRegistryParseError,
	UnitRegistryStore,
} from "./unit-registry-store";

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

	/** note キャッシュ: hash -> decoded note（null は「note 無し」を記録） */
	private noteCache = new Map<string, string | null>();

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
		return path.join(
			Configuration.getInstance().getMdaitDir(),
			"unit-registry",
		);
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
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(filePath),
			new TextEncoder().encode(content),
		);

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
				const fileContent = await vscode.workspace.fs.readFile(
					vscode.Uri.file(filePath),
				);
				const content = new TextDecoder().decode(fileContent);
				this.store.parse(content);
			} catch (error) {
				if (error instanceof UnitRegistryParseError) {
					console.warn(
						"Unit-registry file is in invalid format (possibly v1). Starting fresh:",
						error.message,
					);
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
	 * ユニットに紐づく note（人間/ツールのメタ情報）を保存する。
	 * content とは独立に同一 hash キーへ書き、即座にファイルへ永続化する
	 * （CodeLens 等の直接操作からの呼び出しを想定）。
	 * @param hash ユニットのハッシュ
	 * @param note note 本文。null/空文字で削除
	 */
	async saveNote(hash: string, note: string | null): Promise<void> {
		const store = await this.getOrLoadStore();
		const trimmed = note && note.trim() !== "" ? note : null;
		store.setNote(hash, trimmed ? encodeUnitRegistry(trimmed) : null);
		this.noteCache.set(hash, trimmed);
		await this.persistStore(store);
	}

	/**
	 * ユニットに紐づく note を読み込む。
	 * @param hash ユニットのハッシュ
	 * @returns note 本文、無い場合は null
	 */
	async loadNote(hash: string): Promise<string | null> {
		if (this.noteCache.has(hash)) {
			return this.noteCache.get(hash) ?? null;
		}
		const store = await this.getOrLoadStore();
		const encoded = store.getNote(hash);
		const note = encoded ? decodeUnitRegistry(encoded) : null;
		this.noteCache.set(hash, note);
		return note;
	}

	/**
	 * note を旧ハッシュから新ハッシュへ移送する（sync が本文編集を検出したとき）。
	 * content は content-addressed で不変なので移送しない（note だけがユニットに追従する）。
	 * @param migrations {from, to} の配列（from に note があれば to へ移し、from の note は消す）
	 */
	async migrateNotes(migrations: Array<{ from: string; to: string }>): Promise<void> {
		if (migrations.length === 0) {
			return;
		}
		const store = await this.getOrLoadStore();
		let changed = false;
		for (const { from, to } of migrations) {
			if (from === to) {
				continue;
			}
			const encoded = store.getNote(from);
			if (!encoded) {
				continue;
			}
			store.setNote(to, encoded);
			store.setNote(from, null);
			this.noteCache.set(to, decodeUnitRegistry(encoded));
			this.noteCache.set(from, null);
			changed = true;
		}
		if (changed) {
			await this.persistStore(store);
		}
	}

	/** ストアを正規形でファイルへ書き込む（note 系の即時永続化に使用） */
	private async persistStore(store: UnitRegistryStore): Promise<void> {
		const mdaitDir = await ensureMdaitDir();
		if (!mdaitDir) {
			return;
		}
		const filePath = path.join(mdaitDir, "unit-registry");
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(store.serialize()));
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

		console.log(
			`Running unit-registry GC (file size: ${Math.round(stats.size / 1024)}KB)`,
		);

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
		for (const hash of this.noteCache.keys()) {
			if (!activeHashes.has(hash)) {
				this.noteCache.delete(hash);
			}
		}

		// 正規形でファイルに書き込み
		const content = store.serialize();
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(filePath),
			new TextEncoder().encode(content),
		);

		console.log(
			`GC completed: ${beforeSize} -> ${store.size()} unit-registry entries`,
		);
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
		this.noteCache.clear();
		this.writeBuffer.clear();
		this.store = null;
		this.storeLoaded = false;
	}
}
