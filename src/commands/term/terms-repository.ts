/**
 * @file terms-repository.ts
 * @description 用語集の永続化とバッチ処理を抽象化するリポジトリインターフェース
 */

import type { TransPair } from "../../infra/config/configuration";
import type { TermEntry } from "./term-entry";

/**
 * 用語集リポジトリの抽象インターフェース
 * フォーマット非依存でCSV/YAMLに対応
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
	 * **競合の解決の経路だけが通る読み取り。** 片方の陣営の全文を読み、その版の用語を返す。
	 *
	 * 通常の読み込みは、競合マーカーを見つけたら投げる（ADR-260908-02）。その線は動かさない —
	 * ここは「解決の材料を作るため」の別の入口で、ファイルには触らない。書き出しに要る
	 * 付帯情報（CSV の未知列・列の順、YAML のメタデータ）は読んだぶんだけ引き取る。
	 */
	loadSide(content: string): Promise<readonly TermEntry[]>;

	/**
	 * **競合の解決の経路だけが通る書き出し。** 解いた結果で置き換えて保存する。
	 *
	 * クラスの外に別の書き出しを作らないこと（ADR-260911-02）— 原子的な書き込みと、
	 * 未知列・メタデータの温存はここにしか無い。
	 */
	writeResolved(entries: readonly TermEntry[]): Promise<void>;

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
	 * @param primaryLang 主言語。**渡さないと最初の source 言語で代用される** — 設定の
	 *   `primaryLang` がそれと違う作業場では、語を指す鍵が設定と食い違う
	 */
	export async function create(
		path: string,
		transPairs: readonly TransPair[],
		format?: "csv" | "yaml",
		primaryLang?: string,
	): Promise<TermsRepository> {
		const actualFormat = format ?? detectFormat(path);

		switch (actualFormat) {
			case "csv": {
				const { TermsRepositoryCSV } = await import("./terms-repository-csv.js");
				return TermsRepositoryCSV.create(path, transPairs, primaryLang);
			}
			case "yaml": {
				const { YamlTermsRepository } = await import("./terms-repository-yaml.js");
				return YamlTermsRepository.create(path, transPairs);
			}
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
			default:
				throw new Error(`Unsupported format: ${format}`);
		}
	}

	/**
	 * ファイル拡張子から形式を自動判定
	 */
	function detectFormat(path: string): "csv" | "yaml" {
		const extension = path.toLowerCase().split(".").pop();
		switch (extension) {
			case "yaml":
			case "yml":
				return "yaml";
			default:
				return "csv"; // デフォルト
		}
	}
}
