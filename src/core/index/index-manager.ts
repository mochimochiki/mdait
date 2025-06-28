import * as fs from "node:fs";
import * as path from "node:path";
import type { Configuration } from "../../config/configuration";
import { markdownParser } from "../markdown/parser";
import type { IndexFile, UnitIndex, UnitIndexEntry } from "./index-types";

const INDEX_FILE_NAME = ".mdait/index.json";
const INDEX_VERSION = "1.0.0";

/**
 * インデックスファイルを生成する
 * @param config 設定オブジェクト
 * @param workspaceRoot ワークスペースのルートパス
 * @returns 生成されたインデックスファイルのパス
 */
export async function generateIndexFile(
	config: Configuration,
	workspaceRoot: string,
): Promise<string> {
	const units: UnitIndex = {};

	// 全翻訳ペアの対象ディレクトリからファイルを収集
	const allFiles = await collectTargetFiles(config, workspaceRoot);

	// 各ファイルをパースしてユニット情報を抽出
	for (const filePath of allFiles) {
		try {
			await extractUnitsFromFile(filePath, config, units, workspaceRoot);
		} catch (error) {
			console.warn(`Failed to parse file: ${filePath}`, error);
			// パースエラーがあっても他のファイルの処理は続行
		}
	}

	// インデックスファイルを作成
	const indexFile: IndexFile = {
		metadata: {
			version: INDEX_VERSION,
		},
		units,
	};

	// インデックスファイルを保存
	const indexFilePath = path.join(workspaceRoot, INDEX_FILE_NAME);
	const indexDir = path.dirname(indexFilePath);

	// .mdaitディレクトリが存在しない場合は作成
	try {
		await fs.promises.mkdir(indexDir, { recursive: true });
	} catch (error) {
		// ディレクトリ作成に失敗した場合でも続行（権限エラーなど）
		console.warn(`Failed to create directory ${indexDir}:`, error);
	}

	await fs.promises.writeFile(indexFilePath, JSON.stringify(indexFile, null, 2), "utf-8");

	return indexFilePath;
}

/**
 * インデックスファイルを読み込む
 * @param workspaceRoot ワークスペースのルートパス
 * @returns インデックスファイルの内容、存在しない場合はnull
 */
export async function loadIndexFile(workspaceRoot: string): Promise<IndexFile | null> {
	const indexFilePath = path.join(workspaceRoot, INDEX_FILE_NAME);

	try {
		const content = await fs.promises.readFile(indexFilePath, "utf-8");
		const indexFile: IndexFile = JSON.parse(content);

		// バージョンチェック（必要に応じて古いインデックスは無効化）
		if (indexFile.metadata.version !== INDEX_VERSION) {
			console.warn(
				`Index version mismatch: expected ${INDEX_VERSION}, got ${indexFile.metadata.version}`,
			);
			return null;
		}

		return indexFile;
	} catch (error) {
		// ファイルが存在しない、またはパースエラー
		return null;
	}
}

/**
 * from属性でユニット検索を行う
 * @param indexFile インデックスファイル
 * @param fromHash 検索対象のfromハッシュ
 * @returns マッチしたユニットエントリの配列
 */
export function findUnitsByFromHash(indexFile: IndexFile, fromHash: string): UnitIndexEntry[] {
	return indexFile.units[fromHash] || [];
}

/**
 * 指定ファイルの未翻訳ユニットを取得
 * @param indexFile インデックスファイル
 * @param filePath 対象ファイルパス（絶対パス）
 * @param workspaceRoot ワークスペースのルートパス
 * @returns 未翻訳ユニットの配列
 */
export function getUntranslatedUnits(
	indexFile: IndexFile,
	filePath: string,
	workspaceRoot: string,
): UnitIndexEntry[] {
	const untranslatedUnits: UnitIndexEntry[] = [];
	const relativePath = path.relative(workspaceRoot, filePath);

	for (const hash in indexFile.units) {
		const entries = indexFile.units[hash];
		for (const entry of entries) {
			if (entry.path === relativePath && entry.needFlag === "translate") {
				untranslatedUnits.push(entry);
			}
		}
	}

	return untranslatedUnits;
}

/**
 * 指定ファイルのインデックスエントリを更新する
 * @param workspaceRoot ワークスペースのルートパス
 * @param filePath 更新対象ファイルの絶対パス
 * @param config 設定オブジェクト
 * @returns 更新が成功した場合はtrue
 */
export async function updateIndexForFile(
	workspaceRoot: string,
	filePath: string,
	config: Configuration,
): Promise<boolean> {
	try {
		// 既存のインデックスファイルを読み込み
		const indexFile = await loadIndexFile(workspaceRoot);
		if (!indexFile) {
			console.warn("Index file not found, skipping update");
			return false;
		}

		const relativePath = path.relative(workspaceRoot, filePath);

		// 既存の該当ファイルのエントリを削除
		for (const hash in indexFile.units) {
			indexFile.units[hash] = indexFile.units[hash].filter((entry) => entry.path !== relativePath);
			// エントリがなくなったハッシュキーは削除
			if (indexFile.units[hash].length === 0) {
				delete indexFile.units[hash];
			}
		}

		// ファイルを再パースして新しいエントリを追加
		await extractUnitsFromFile(filePath, config, indexFile.units, workspaceRoot);

		// インデックスファイルを保存
		const indexFilePath = path.join(workspaceRoot, INDEX_FILE_NAME);
		await fs.promises.writeFile(indexFilePath, JSON.stringify(indexFile, null, 2), "utf-8");

		return true;
	} catch (error) {
		console.warn(`Failed to update index for file ${filePath}:`, error);
		return false;
	}
}

/**
 * 対象ファイル一覧を収集する
 */
async function collectTargetFiles(config: Configuration, workspaceRoot: string): Promise<string[]> {
	const allFiles: string[] = [];

	// 各翻訳ペアのsourceDir, targetDirから.mdファイルを収集
	for (const pair of config.transPairs) {
		const sourceDirAbs = path.resolve(workspaceRoot, pair.sourceDir);
		const targetDirAbs = path.resolve(workspaceRoot, pair.targetDir);

		const sourceFiles = await findMarkdownFiles(sourceDirAbs);
		const targetFiles = await findMarkdownFiles(targetDirAbs);

		allFiles.push(...sourceFiles, ...targetFiles);
	}

	// 重複を除去
	return [...new Set(allFiles)];
}

/**
 * 指定ディレクトリから.mdファイルを再帰的に検索
 */
async function findMarkdownFiles(dirPath: string): Promise<string[]> {
	const files: string[] = [];

	try {
		const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);

			if (entry.isDirectory()) {
				const subFiles = await findMarkdownFiles(fullPath);
				files.push(...subFiles);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(fullPath);
			}
		}
	} catch (error) {
		// ディレクトリが存在しない場合などは無視
		console.warn(`Failed to read directory: ${dirPath}`, error);
	}

	return files;
}

/**
 * 単一ファイルからユニット情報を抽出してインデックスに追加
 */
async function extractUnitsFromFile(
	filePath: string,
	config: Configuration,
	units: UnitIndex,
	workspaceRoot: string,
): Promise<void> {
	const content = await fs.promises.readFile(filePath, "utf-8");
	const markdown = markdownParser.parse(content, config);

	// 言語を翻訳ペア設定から取得
	const lang = GetLanguageFromPath(filePath, config);

	// インデックスファイルからの相対パスを計算
	const relativePath = path.relative(workspaceRoot, filePath);

	// 各ユニットをインデックスに追加
	for (let i = 0; i < markdown.units.length; i++) {
		const unit = markdown.units[i];

		if (!unit.marker?.hash) {
			continue; // ハッシュがないユニットはスキップ
		}

		const entry: UnitIndexEntry = {
			type: "md",
			lang,
			path: relativePath,
			unitIndex: i,
			from: unit.marker.from || null,
			title: extractTitle(unit.content),
			startLine: unit.startLine,
			endLine: unit.endLine,
			needFlag: unit.marker.need || null,
		};

		// hash主キー形式でインデックスに追加
		if (!units[unit.marker.hash]) {
			units[unit.marker.hash] = [];
		}
		units[unit.marker.hash].push(entry);
	}
}

/**
 * ファイルパスから言語を取得
 * sourceDir優先、なければtargetDirで判定
 */
function GetLanguageFromPath(filePath: string, config: Configuration): string {
	const pairSource = config.getTransPairForSourceFile(filePath);
	if (pairSource) {
		return pairSource.sourceLang;
	}
	const pairTarget = config.getTransPairForTargetFile(filePath);
	if (pairTarget) {
		return pairTarget.targetLang;
	}
	return "unknown";
}

/**
 * ユニットコンテンツからタイトルを抽出（簡易版）
 */
function extractTitle(content: string): string {
	const lines = content.trim().split("\n");

	// 最初の見出し行を探す
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) {
			return trimmed.substring(0, 50); // 最大50文字まで
		}
	}

	// 見出しがない場合は最初の非空行
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return `${trimmed.substring(0, 30)}...`;
		}
	}

	return "Untitled";
}
