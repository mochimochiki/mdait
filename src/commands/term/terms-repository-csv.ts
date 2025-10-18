/**
 * @file csv-terms-repository.ts
 * @description CSV形式の用語集リポジトリ実装
 * BOM対応、UTF-8エンコーディング、型安全なバッチ処理を提供
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import type { TransPair } from "../../config/configuration";
import { Configuration } from "../../config/configuration";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";
import { TermEntryConverter } from "./term-entry-converter";
import { extractLanguagesFromTransPairs } from "./term-utils";
import type { RepositoryStats, TermsRepository } from "./terms-repository";

/**
 * CSV形式の用語集リポジトリ
 */
export class TermsRepositoryCSV implements TermsRepository {
	private entries: TermEntry[] = [];
	private allLanguages: string[] = [];
	// 既存CSVに存在するが本実装が管理しない列（target側variants含む）名の保持
	private preservedHeaders: string[] = [];
	// 行ごとの未知列値をキー付きで保持
	private preservedPerKey: Map<string, Record<string, string>> = new Map();
	// source言語セット（variants列の自動付与対象）
	private sourceLanguages: Set<string> = new Set();

	private constructor(public readonly path: string) {}

	/**
	 * 新しいCSVリポジトリを作成
	 */
	static async create(path: string, transPairs: readonly TransPair[]): Promise<TermsRepositoryCSV> {
		const repository = new TermsRepositoryCSV(path);

		// transPairsから言語リストを抽出
		repository.allLanguages = extractLanguagesFromTransPairs(transPairs);
		// source言語セットを更新
		repository.updateSourceLanguages(transPairs);

		// 空のリポジトリとして初期化
		repository.entries = [];

		return repository;
	}

	/**
	 * 既存CSVファイルを読み込み
	 */
	static async load(path: string): Promise<TermsRepositoryCSV> {
		const repository = new TermsRepositoryCSV(path);
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
		// 言語リストを更新（transPairの順序を保持）
		const newLanguages = extractLanguagesFromTransPairs(transPairs);
		const existingLanguages = this.allLanguages;
		const mergedLanguages: string[] = [];
		const seen = new Set<string>();

		// 既存の言語の順序を保持
		for (const lang of existingLanguages) {
			mergedLanguages.push(lang);
			seen.add(lang);
		}

		// 新しい言語をtransPairの順序で追加
		for (const lang of newLanguages) {
			if (!seen.has(lang)) {
				mergedLanguages.push(lang);
				seen.add(lang);
			}
		}

		this.allLanguages = mergedLanguages;

		// source言語セットを更新
		this.updateSourceLanguages(transPairs);

		// primaryLangを取得
		const config = Configuration.getInstance();
		const primaryLang = config.getTermsPrimaryLang();

		// 既存エントリをコピー
		const mergedEntries = [...this.entries];

		// 候補エントリを順次マージ
		for (const candidate of candidates) {
			// 空のエントリはスキップ
			if (TermEntryUtils.isEmpty(candidate)) continue;

			// 既存エントリとの重複チェック（primaryLangで判定）
			const duplicateIndex = mergedEntries.findIndex((existing) =>
				TermEntryUtils.isDuplicate(existing, candidate, primaryLang),
			);

			if (duplicateIndex >= 0) {
				// 重複の場合は既存を保持（設計通り）
				continue;
			}

			// 候補同士の重複チェック
			const hasDuplicateInCandidates = mergedEntries
				.slice(this.entries.length)
				.some((other) => TermEntryUtils.isDuplicate(other, candidate, primaryLang));

			if (!hasDuplicateInCandidates) {
				mergedEntries.push(candidate);
			}
		}

		// ソート（最初の言語の用語でソート）
		if (this.allLanguages.length > 0) {
			const primaryLanguage = this.allLanguages[0];
			mergedEntries.sort((a, b) => {
				const termA = TermEntryUtils.getTerm(a, primaryLanguage) || "";
				const termB = TermEntryUtils.getTerm(b, primaryLanguage) || "";
				return termA.localeCompare(termB);
			});
		}

		this.entries = mergedEntries;
	}

	// 内部: transPairsからsource言語セットを更新
	private updateSourceLanguages(transPairs: readonly TransPair[]): void {
		this.sourceLanguages = buildSourceLanguageSet(transPairs);
	}

	// 内部: 有効なprimaryLangを決定
	private getEffectivePrimaryLang(): string {
		const config = Configuration.getInstance();
		const configured = (config.getTermsPrimaryLang() || "").trim();
		if (configured) return configured;
		// 未設定の場合は最初のsourceLang
		for (const p of config.transPairs) {
			if (p.sourceLang) return p.sourceLang;
		}
		// それも無ければallLanguages先頭
		return this.allLanguages[0] || "";
	}

	// 内部: 列順序（primary → source → target → context → variants → unknown）に必要な情報を返す
	private getOrderedLangs(): { sourceOrder: string[]; targetOrder: string[]; primary: string } {
		const config = Configuration.getInstance();
		const primary = this.getEffectivePrimaryLang();
		const langSet = new Set(this.allLanguages);

		const seenS = new Set<string>();
		const seenT = new Set<string>();
		const sourceOrder: string[] = [];
		const targetOrder: string[] = [];

		for (const pair of config.transPairs) {
			if (pair.sourceLang && langSet.has(pair.sourceLang) && !seenS.has(pair.sourceLang)) {
				seenS.add(pair.sourceLang);
				sourceOrder.push(pair.sourceLang);
			}
			if (pair.targetLang && langSet.has(pair.targetLang) && !seenT.has(pair.targetLang)) {
				seenT.add(pair.targetLang);
				targetOrder.push(pair.targetLang);
			}
		}

		// transPairsに載っていないがallLanguagesに居る言語を補完
		for (const l of this.allLanguages) {
			if (!seenS.has(l) && this.sourceLanguages.has(l)) {
				seenS.add(l);
				sourceOrder.push(l);
			}
			if (!seenT.has(l) && !this.sourceLanguages.has(l)) {
				seenT.add(l);
				targetOrder.push(l);
			}
		}

		return { sourceOrder, targetOrder, primary };
	}

	// 内部: エントリを特定するキー（primaryLangの用語 + context）
	private computeEntryKey(entry: TermEntry): string {
		const primary = this.getEffectivePrimaryLang();
		const term = TermEntryUtils.getTerm(entry, primary) || "";
		return `${primary}:${term}::${entry.context}`;
	}

	// 内部: エントリに対応する未知列の値を取得（なければ空で初期化）
	private getPreservedForEntry(entry: TermEntry): Record<string, string> {
		const key = this.computeEntryKey(entry);
		const existing = this.preservedPerKey.get(key);
		if (existing) return { ...existing };
		const blank: Record<string, string> = {};
		for (const h of this.preservedHeaders) blank[h] = "";
		return blank;
	}

	/**
	 * CSVファイルに保存
	 */
	async save(): Promise<void> {
		// ディレクトリが存在しない場合は作成
		const dirPath = path.dirname(this.path);
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}

		// 設定から最新のsource言語セットを取得（ロード後に設定が変わる可能性に備える）
		const config = Configuration.getInstance();
		this.updateSourceLanguages(config.transPairs);
		const { sourceOrder, targetOrder, primary } = this.getOrderedLangs();

		// CSVヘッダーを生成（primary → source順序 → target順序 → context → variants（sourceのみ）→ unknown）
		const headers = generateOrderedCsvHeaders(primary, sourceOrder, targetOrder, this.preservedHeaders);

		// TermEntryをCSV行に変換しつつ未知列を温存
		const rows = this.entries.map((entry) => {
			const base = this.getPreservedForEntry(entry);
			// 既存のロジックで言語列とvariants（全言語分）を一旦作る
			const full = TermEntryConverter.toCsvRow(entry, this.allLanguages);
			// 出力行: 未知列をベースに、管理する列を上書き
			const out: Record<string, string> = { ...base };
			out.context = full.context;
			for (const lang of this.allLanguages) {
				out[lang] = full[lang] ?? "";
				if (this.sourceLanguages.has(lang)) {
					const vk = `variants_${lang}`;
					out[vk] = full[vk] ?? "";
				}
			}
			return out;
		});

		// CSV文字列を生成
		const csvContent = stringify(rows, {
			header: true,
			columns: headers,
		});

		// BOM付きUTF-8で保存
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		const contentBuffer = Buffer.from(csvContent, "utf8");
		fs.writeFileSync(this.path, Buffer.concat([bom, contentBuffer]));
	}

	/**
	 * 統計情報を取得
	 */
	async getStats(): Promise<RepositoryStats> {
		const entriesByLanguage: Record<string, number> = {};

		for (const lang of this.allLanguages) {
			entriesByLanguage[lang] = this.entries.filter((entry) => TermEntryUtils.hasLanguage(entry, lang)).length;
		}

		let lastModified: Date | undefined;
		try {
			const stats = fs.statSync(this.path);
			lastModified = stats.mtime;
		} catch {
			// ファイルが存在しない場合は無視
		}

		return {
			totalEntries: this.entries.length,
			entriesByLanguage,
			lastModified,
		};
	}

	/**
	 * CSVファイルから読み込み
	 */
	private async loadFromFile(): Promise<void> {
		if (!fs.existsSync(this.path)) {
			this.entries = [];
			this.allLanguages = [];
			this.preservedHeaders = [];
			this.preservedPerKey.clear();
			return;
		}

		// ファイル読み込み（BOM対応）
		let content = fs.readFileSync(this.path, "utf8");
		if (content.charCodeAt(0) === 0xfeff) {
			content = content.slice(1); // BOM除去
		}

		// CSVパース
		const records = parse(content, {
			columns: true,
			skip_empty_lines: true,
		}) as Record<string, string>[];

		if (records.length === 0) {
			this.entries = [];
			this.allLanguages = [];
			this.preservedHeaders = [];
			this.preservedPerKey.clear();
			return;
		}

		// ヘッダーから言語リストを抽出
		const headers = Object.keys(records[0]);
		this.allLanguages = TermEntryConverter.extractLanguagesFromHeaders(headers);
		// 最新設定からsource言語セットを更新
		const config = Configuration.getInstance();
		this.updateSourceLanguages(config.transPairs);
		// 管理対象の列集合を作り、未知列ヘッダーを記録
		const managed = new Set<string>([
			"context",
			...this.allLanguages,
			...Array.from(this.sourceLanguages).map((l) => `variants_${l}`),
		]);
		this.preservedHeaders = headers.filter((h) => !managed.has(h));
		this.preservedPerKey.clear();

		// 各行をTermEntryに変換しつつ未知列を保持
		const tmpEntries: TermEntry[] = [];
		for (const row of records) {
			const entry = TermEntryConverter.fromCsvRow(row, this.allLanguages);
			if (TermEntryUtils.isEmpty(entry)) continue;
			tmpEntries.push(entry);
			const key = this.computeEntryKey(entry);
			const preserved: Record<string, string> = {};
			for (const h of this.preservedHeaders) {
				preserved[h] = row[h] ?? "";
			}
			this.preservedPerKey.set(key, preserved);
		}
		this.entries = tmpEntries;
	}
}

/**
 * CSVヘッダーを生成
 * 形式: [primary, source順序ごと, target順序ごと, context, variants] + preservedHeaders
 */
function generateOrderedCsvHeaders(
	primaryLang: string,
	sourceOrder: readonly string[],
	targetOrder: readonly string[],
	preservedHeaders: readonly string[],
): string[] {
	const headers: string[] = [];
	const placedLangs = new Set<string>();

	// primary
	if (primaryLang) {
		headers.push(primaryLang);
		placedLangs.add(primaryLang);
	}

	// 残りのsource（primary以外）
	for (const lang of sourceOrder) {
		if (lang && !placedLangs.has(lang)) {
			if (lang !== primaryLang) {
				headers.push(lang);
				placedLangs.add(lang);
			}
		}
	}

	// target
	for (const lang of targetOrder) {
		if (lang && !placedLangs.has(lang)) {
			headers.push(lang);
			placedLangs.add(lang);
		}
	}

	// context
	headers.push("context");

	// variants（sourceのみ）
	for (const lang of sourceOrder) {
		if (lang) headers.push(`variants_${lang}`);
	}

	// 既存CSVにあった未知列を末尾に温存
	for (const h of preservedHeaders) {
		if (h && !headers.includes(h)) headers.push(h);
	}

	return headers;
}

// 内部ユーティリティ: source言語セットの更新
// 重複を除いたsourceLangのみを保持
function buildSourceLanguageSet(transPairs: readonly TransPair[]): Set<string> {
	const set = new Set<string>();
	for (const p of transPairs) {
		if (p.sourceLang) set.add(p.sourceLang);
	}
	return set;
}

// 内部ユーティリティ: 設定から有効なprimaryLangを決定
// 未設定（空文字など）の場合は最初のsourceLangを使用、なければallLanguagesの先頭を使用
// 注意: クラス外の関数ではないため利用側はメソッドとしてTermsRepositoryCSVに実装
