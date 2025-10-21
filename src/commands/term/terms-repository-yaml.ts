/**
 * @file terms-repository-yaml.ts
 * @description YAML形式の用語集リポジトリ実装
 * js-yamlを使用してYAML形式の用語集ファイルを扱う
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

import type { TransPair } from "../../config/configuration";
import { Configuration } from "../../config/configuration";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";
import { extractLanguagesFromTransPairs } from "./term-utils";
import type { RepositoryStats, TermsRepository } from "./terms-repository";

/**
 * YAML形式の用語集ファイル構造
 */
interface YamlTermsFile {
	metadata?: {
		version?: string;
		created?: string;
		last_updated?: string;
		description?: string;
		languages?: string[];
	};
	terms: YamlTermEntry[];
}

/**
 * YAML形式の用語エントリ
 */
interface YamlTermEntry {
	context: string;
	languages: Record<
		string,
		{
			term: string;
			variants: string[];
		}
	>;
}

/**
 * YAML形式の用語集リポジトリ
 */
export class YamlTermsRepository implements TermsRepository {
	private entries: TermEntry[] = [];
	private metadata: YamlTermsFile["metadata"] = {};
	private allLanguages: string[] = [];

	private constructor(public readonly path: string) {}

	/**
	 * 新しいYAMLリポジトリを作成
	 */
	static async create(path: string, transPairs: readonly TransPair[]): Promise<YamlTermsRepository> {
		const repository = new YamlTermsRepository(path);

		// transPairsから言語リストを抽出
		repository.allLanguages = extractLanguagesFromTransPairs(transPairs);

		// メタデータを初期化
		repository.metadata = {
			version: "1.0.0",
			created: new Date().toISOString().split("T")[0],
			last_updated: new Date().toISOString().split("T")[0],
			description: "mdait用語集",
			languages: repository.allLanguages,
		};

		// 空のリポジトリとして初期化
		repository.entries = [];

		return repository;
	}

	/**
	 * 既存YAMLファイルを読み込み
	 */
	static async load(path: string): Promise<YamlTermsRepository> {
		const repository = new YamlTermsRepository(path);
		await repository.loadFromFile();
		return repository;
	}

	/**
	 * 全ての用語エントリを取得
	 */
	async getAllEntries(): Promise<readonly TermEntry[]> {
		return [...this.entries];
	}

	/**
	 * 用語エントリをバッチでマージ
	 */
	async Merge(candidates: readonly TermEntry[], transPairs: readonly TransPair[]): Promise<void> {
		const config = Configuration.getInstance();
		const primaryLang = config.getTermsPrimaryLang();
		const mergedEntries: TermEntry[] = [...this.entries];

		for (const candidate of candidates) {
			// 空のエントリはスキップ
			if (TermEntryUtils.isEmpty(candidate)) continue;

			// 既存エントリとの同一性チェック（contextと言語で判定）
			const duplicateIndex = mergedEntries.findIndex((existing) =>
				TermEntryUtils.isSameEntry(existing, candidate, primaryLang),
			);

			if (duplicateIndex >= 0) {
				// 同一エントリが見つかった場合はマージで更新
				mergedEntries[duplicateIndex] = TermEntryUtils.merge(mergedEntries[duplicateIndex], candidate);
			} else {
				// 新規エントリとして追加
				mergedEntries.push(candidate);
			}
		}

		this.entries = mergedEntries;
		this.updateMetadata();
	}

	/**
	 * 永続化
	 */
	async save(): Promise<void> {
		// ディレクトリが存在しない場合は作成
		const dir = path.dirname(this.path);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// YAML形式に変換
		const yamlData: YamlTermsFile = {
			metadata: this.metadata,
			terms: this.entries.map(this.convertToYamlEntry),
		};

		// YAMLとしてシリアライズ
		const yamlContent = yaml.dump(yamlData, {
			indent: 2,
			lineWidth: -1,
			noRefs: true,
			sortKeys: false,
		});

		// ファイルに書き込み（UTF-8、BOM無し）
		fs.writeFileSync(this.path, yamlContent, { encoding: "utf8" });
	}

	/**
	 * 統計情報の取得
	 */
	async getStats(): Promise<RepositoryStats> {
		const entriesByLanguage: Record<string, number> = {};

		for (const entry of this.entries) {
			for (const lang of TermEntryUtils.getLanguages(entry)) {
				entriesByLanguage[lang] = (entriesByLanguage[lang] || 0) + 1;
			}
		}

		let lastModified: Date | undefined;
		if (fs.existsSync(this.path)) {
			const stats = fs.statSync(this.path);
			lastModified = stats.mtime;
		}

		return {
			totalEntries: this.entries.length,
			entriesByLanguage,
			lastModified,
		};
	}

	/**
	 * YAMLファイルからデータを読み込み
	 */
	private async loadFromFile(): Promise<void> {
		if (!fs.existsSync(this.path)) {
			// ファイルが存在しない場合は空のリポジトリとして初期化
			this.entries = [];
			this.metadata = {};
			this.allLanguages = [];
			return;
		}

		try {
			// ファイルを読み込み
			const content = fs.readFileSync(this.path, { encoding: "utf8" });

			// YAMLをパース
			const yamlData = yaml.load(content) as YamlTermsFile;

			if (!yamlData || typeof yamlData !== "object") {
				throw new Error("Invalid YAML structure");
			}

			// メタデータを保存
			this.metadata = yamlData.metadata || {};
			this.allLanguages = this.metadata.languages || [];

			// 用語エントリを変換
			this.entries = (yamlData.terms || []).map(this.convertFromYamlEntry);
		} catch (error) {
			throw new Error(`Failed to load YAML file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * TermEntryをYAML形式に変換
	 */
	private convertToYamlEntry(entry: TermEntry): YamlTermEntry {
		const languages: Record<string, { term: string; variants: string[] }> = {};

		for (const [lang, info] of Object.entries(entry.languages)) {
			languages[lang] = {
				term: info.term,
				variants: [...info.variants],
			};
		}

		const yamlEntry: YamlTermEntry = {
			context: entry.context,
			languages,
		};

		return yamlEntry;
	}

	/**
	 * YAML形式からTermEntryに変換
	 */
	private convertFromYamlEntry(yamlEntry: YamlTermEntry): TermEntry {
		const languages: Record<string, { term: string; variants: readonly string[] }> = {};

		for (const [lang, info] of Object.entries(yamlEntry.languages)) {
			languages[lang] = {
				term: info.term,
				variants: info.variants || [],
			};
		}

		return TermEntryUtils.create(yamlEntry.context, languages);
	}

	/**
	 * メタデータを更新
	 */
	private updateMetadata(): void {
		if (!this.metadata) {
			this.metadata = {};
		}
		this.metadata.last_updated = new Date().toISOString().split("T")[0];

		// 現在のエントリから言語リストを更新
		const languages = new Set<string>();
		for (const entry of this.entries) {
			for (const lang of TermEntryUtils.getLanguages(entry)) {
				languages.add(lang);
			}
		}
		this.metadata.languages = Array.from(languages).sort();
	}
}
