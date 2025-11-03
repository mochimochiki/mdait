/**
 * @file terms-cache-manager.ts
 * @description 用語集ファイルのキャッシュ管理
 * mtimeベースで更新検知し、staleなキャッシュを破棄して再読み込みする
 */

import * as fs from "node:fs";
import type { Configuration, TransPair } from "../../config/configuration";
import type { TermEntry } from "../term/term-entry";
import { TermsRepository } from "../term/terms-repository";

/**
 * 用語集キャッシュのエントリ
 */
interface CacheEntry {
	/** 用語エントリ配列 */
	entries: readonly TermEntry[];
	/** キャッシュ時のファイルmtime */
	mtime: number;
}

/**
 * 用語集ファイルのキャッシュを管理するシングルトンクラス
 */
export class TermsCacheManager {
	private static instance: TermsCacheManager | undefined;
	private cache: Map<string, CacheEntry> = new Map();

	private constructor() {}

	/**
	 * シングルトンインスタンスを取得
	 */
	public static getInstance(): TermsCacheManager {
		if (!TermsCacheManager.instance) {
			TermsCacheManager.instance = new TermsCacheManager();
		}
		return TermsCacheManager.instance;
	}

	/**
	 * テスト用: インスタンスをクリア
	 */
	public static dispose(): void {
		if (TermsCacheManager.instance) {
			TermsCacheManager.instance.cache.clear();
		}
		TermsCacheManager.instance = undefined;
	}

	/**
	 * 用語集を取得（キャッシュがあれば利用、なければロード）
	 * @param termsFilePath 用語集ファイルの絶対パス
	 * @param transPairs 翻訳ペア設定
	 * @returns 用語エントリ配列（ファイルが存在しない場合は空配列）
	 */
	public async getTerms(termsFilePath: string, transPairs: readonly TransPair[]): Promise<readonly TermEntry[]> {
		// ファイルが存在しない場合は空配列を返す
		if (!fs.existsSync(termsFilePath)) {
			return [];
		}

		try {
			// ファイルのmtimeを取得
			const stats = fs.statSync(termsFilePath);
			const currentMtime = stats.mtimeMs;

			// キャッシュをチェック
			const cached = this.cache.get(termsFilePath);
			if (cached && cached.mtime === currentMtime) {
				// キャッシュが有効
				return cached.entries;
			}

			// キャッシュが無効またはファイルが更新されている場合は再読み込み
			const repository = await TermsRepository.load(termsFilePath);
			const entries = await repository.getAllEntries();

			// キャッシュを更新
			this.cache.set(termsFilePath, {
				entries,
				mtime: currentMtime,
			});

			return entries;
		} catch (error) {
			// エラー時は警告なしで空配列を返す（考慮事項に基づく）
			console.warn(`Failed to load terms from ${termsFilePath}:`, error);
			return [];
		}
	}

	/**
	 * キャッシュをクリア
	 * @param termsFilePath 特定のファイルのキャッシュのみクリア（省略時は全クリア）
	 */
	public clearCache(termsFilePath?: string): void {
		if (termsFilePath) {
			this.cache.delete(termsFilePath);
		} else {
			this.cache.clear();
		}
	}
}
