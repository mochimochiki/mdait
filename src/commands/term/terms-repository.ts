/**
 * @file terms-repository.ts
 * @description 用語集の永続化とバッチ処理を抽象化するリポジトリインターフェース
 */

import type { TransPair } from "../../config/configuration";
import type { TermEntry } from "./term-entry";

/**
 * 用語集リポジトリの抽象インターフェース
 * フォーマット非依存でCSV/YAML/JSON等に対応可能
 */
export interface TermsRepository {
	/**
	 * リポジトリパス
	 */
	readonly path: string;

	/**
	 * 全ての用語エントリを取得
	 */
	getAllEntries(): Promise<readonly TermEntry[]>;

	/**
	 * 用語エントリをマージ
	 * 重複除去と既存データとの統合を行う
	 *
	 * @param candidates 新しい候補エントリ
	 * @param transPairs 対象言語ペア（重複検知に使用）
	 */
	Merge(candidates: readonly TermEntry[], transPairs: readonly TransPair[]): Promise<void>;

	/**
	 * 永続化
	 */
	save(): Promise<void>;

	/**
	 * 統計情報の取得
	/**
	 * 統計情報の取得
	 */
	getStats(): Promise<RepositoryStats>;
}

/**
 * リポジトリ統計情報
 */
export interface RepositoryStats {
	/** 総エントリ数 */
	totalEntries: number;
	/** 言語別エントリ数 */
	entriesByLanguage: Record<string, number>;
	/** 最終更新日時 */
	lastModified?: Date;
}

/**
 * TermsRepositoryファクトリー
 */
export namespace TermsRepository {
	/**
	 * 新しいリポジトリを作成（ファイルが存在しない場合）
	 *
	 * @param path ファイルパス
	 * @param transPairs 初期化に使用する言語ペア
	 * @param format ファイル形式（拡張子から自動判定）
	 */
	export async function create(
		path: string,
		transPairs: readonly TransPair[],
		format?: "csv" | "yaml" | "json",
	): Promise<TermsRepository> {
		const actualFormat = format ?? detectFormat(path);

		switch (actualFormat) {
			case "csv": {
				const { TermsRepositoryCSV } = await import("./terms-repository-csv.js");
				return TermsRepositoryCSV.create(path, transPairs);
			}
			case "yaml": {
				const { YamlTermsRepository } = await import("./terms-repository-yaml.js");
				return YamlTermsRepository.create(path, transPairs);
			}
			case "json":
				// 将来実装
				throw new Error("JSON format is not yet implemented");
			default:
				throw new Error(`Unsupported format: ${actualFormat}`);
		}
	}

	/**
	 * 既存リポジトリを読み込み
	 *
	 * @param path ファイルパス
	 */
	export async function load(path: string): Promise<TermsRepository> {
		const format = detectFormat(path);

		switch (format) {
			case "csv": {
				const { TermsRepositoryCSV } = await import("./terms-repository-csv.js");
				return TermsRepositoryCSV.load(path);
			}
			case "yaml": {
				const { YamlTermsRepository } = await import("./terms-repository-yaml.js");
				return YamlTermsRepository.load(path);
			}
			case "json":
				// 将来実装
				throw new Error("JSON format is not yet implemented");
			default:
				throw new Error(`Unsupported format: ${format}`);
		}
	}

	/**
	 * ファイル拡張子から形式を自動判定
	 */
	function detectFormat(path: string): "csv" | "yaml" | "json" {
		const extension = path.toLowerCase().split(".").pop();
		switch (extension) {
			case "csv":
				return "csv";
			case "yaml":
			case "yml":
				return "yaml";
			case "json":
				return "json";
			default:
				return "csv"; // デフォルト
		}
	}
}
