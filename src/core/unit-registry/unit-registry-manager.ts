import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import {
	decodeUnitRegistry,
	encodeUnitRegistry,
} from "./unit-registry-encoder";
import { isCleanParse, UnitRegistryStore } from "./unit-registry-store";

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

	/** 読み取りに傷があったとき、上書きする前に元のバイト列を避難させる先 */
	private static readonly SALVAGE_FILE_NAME = "unit-registry.broken";

	/** 次にファイルを書く前に、いまディスクにあるバイト列を避難させるか */
	private needsSalvage = false;

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
		const store = await this.getOrLoadStore();
		await this.persistStore(store);
	}

	/** 保留中の writeBuffer（content スナップショット）をストアへマージしてクリアする */
	private mergeWriteBufferInto(store: UnitRegistryStore): void {
		if (this.writeBuffer.size === 0) {
			return;
		}
		for (const [hash, encoded] of this.writeBuffer) {
			store.upsert(hash, encoded);
		}
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
				const report = this.store.parse(content);
				if (!isCleanParse(report)) {
					// 読める行はすべて残っている。残りは避難させた原本にしか無い
					this.needsSalvage = true;
					Logger.getInstance().warn(
						"unit-registry",
						`Could not read every line of the unit registry; kept ${this.store.size()} snapshot(s)`,
						report,
					);
				}
			} catch (error) {
				// **空のストアで続けるが、上書きする前に原本は必ず避難させる。**
				// ここに控えてある旧原文はどこにも複製が無く、黙って上書きすると
				// `need:revise@X` の戻り先が永久に引けなくなる
				this.needsSalvage = true;
				this.store = new UnitRegistryStore();
				Logger.getInstance().warn(
					"unit-registry",
					"Failed to read the unit registry; continuing with an empty one",
					formatError(error),
				);
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

	/**
	 * ストアを正規形でファイルへ書き込む（flushBuffer / note 系の即時永続化で共有）。
	 * 保留中の writeBuffer（content スナップショット）も必ずマージしてから書くため、
	 * saveNote/migrateNotes が flushBuffer 前に走ってもバッファ内容を取りこぼさない。
	 */
	private async persistStore(store: UnitRegistryStore): Promise<void> {
		const mdaitDir = await ensureMdaitDir();
		if (!mdaitDir) {
			return;
		}
		this.mergeWriteBufferInto(store);
		const filePath = path.join(mdaitDir, "unit-registry");
		this.salvageBeforeOverwrite(filePath, mdaitDir);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(store.serialize()));
	}

	/**
	 * 読み取りに傷があった回だけ、上書きの直前に原本を横へ写す。
	 *
	 * 控えは content-addressed の圧縮文字列なので、行が壊れると人の目でも直せない。
	 * それでも**原本が残っていれば直せる見込みがある**が、上書きしてしまえば何も残らない。
	 *
	 * 既に `unit-registry.broken` があるなら**上書きしない** — まだ誰も片付けていない
	 * 避難先を、次に壊れた回のもので潰すと、最初の事故の姿が消える。
	 */
	private salvageBeforeOverwrite(filePath: string, mdaitDir: string): void {
		if (!this.needsSalvage) {
			return;
		}
		this.needsSalvage = false;
		const logger = Logger.getInstance();
		const salvagePath = path.join(mdaitDir, UnitRegistryManager.SALVAGE_FILE_NAME);
		try {
			if (!fs.existsSync(filePath)) {
				return;
			}
			if (fs.existsSync(salvagePath)) {
				logger.warn(
					"unit-registry",
					`Kept the existing ${UnitRegistryManager.SALVAGE_FILE_NAME}; this run's registry was not saved aside`,
				);
				return;
			}
			fs.copyFileSync(filePath, salvagePath);
			logger.warn(
				"unit-registry",
				`Saved the registry as it was read to ${UnitRegistryManager.SALVAGE_FILE_NAME} before overwriting it`,
			);
		} catch (error) {
			logger.warn("unit-registry", "Failed to save the original unit registry", formatError(error));
		}
	}

	/**
	 * 不要なユニットレジストリを削除（GC）
	 *
	 * **使用中のハッシュが1つも渡されなかったら何もしない。** 渡されるのはステータスツリーから
	 * 集めた印で、ツリーがまだ組み上がっていない・収集に失敗した回は空で来る。それを
	 * 「どれも使われていない」と読むと控えを全部消してしまい、`need:revise@X` の戻り先が
	 * 二度と引けなくなる。**残しすぎは次の GC で減らせるが、消しすぎは取り返せない。**
	 *
	 * @param activeHashes 現在使用中のハッシュセット
	 */
	async garbageCollect(activeHashes: Set<string>): Promise<void> {
		const filePath = this.getUnitRegistryFilePath();
		if (!filePath || !fs.existsSync(filePath)) {
			return;
		}

		if (activeHashes.size === 0) {
			Logger.getInstance().warn(
				"unit-registry",
				"Skipped unit-registry GC: no active hashes were collected (an empty set would delete every snapshot)",
			);
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
		this.salvageBeforeOverwrite(filePath, path.dirname(filePath));
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
		this.needsSalvage = false;
	}
}
