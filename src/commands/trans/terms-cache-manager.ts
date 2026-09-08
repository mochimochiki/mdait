/**
 * @file terms-cache-manager.ts
 * @description 用語集ファイルのキャッシュ管理
 * mtimeベースで更新検知し、staleなキャッシュを破棄して再読み込みする
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Configuration, TransPair } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
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
const logger = Logger.getInstance();

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
	/** 読めないと知らせ済みの用語集（同じファイルで繰り返し出さないため） */
	private readonly warnedPaths = new Set<string>();

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
			// **用語集が読めなくても翻訳は止めない。** ただし黙って進めてもいけない —
			// 用語集の無い状態で AI が訳すのは、訳語がぶれるという形で結果に出る。
			// 同じファイルで繰り返し出さないよう、1度だけ知らせる
			if (!this.warnedPaths.has(termsFilePath)) {
				this.warnedPaths.add(termsFilePath);
				logger.warn("trans", "Glossary could not be read; translating without it", {
					termsFilePath,
					...formatError(error),
				});
				vscode.window.showWarningMessage(
					vscode.l10n.t("Could not read the glossary. Translating without it: {0}", (error as Error).message),
				);
			}
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
