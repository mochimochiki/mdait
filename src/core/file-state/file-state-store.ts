import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../../infra/logging/logger";

const logger = Logger.getInstance();

/** file-stateファイル名 */
const FILE_STATE_FILENAME = "file-state";

/** ヘッダーコメント行 */
const HEADER_LINES = [
	"# mdait file-state — ターゲットファイルの翻訳状態管理",
	"# path\thash\tfrom\tneed",
];

/** TSVのカラム数 */
const EXPECTED_COLUMN_COUNT = 4;

/** file-stateエントリ */
export interface FileStateEntry {
	/** ワークスペース相対パス */
	targetPath: string;
	/** ターゲットファイル内容のCRC32 hash */
	hash: string;
	/** 翻訳元ソースファイルのhash */
	fromHash: string;
	/** '' | 'translate' | 'revise@...' | 'review' */
	need: string;
}

/**
 * 非MDファイルの翻訳状態を管理するストア。
 * `.mdait/file-state` のTSV行ベースフォーマットを読み書きする。
 * シングルトンパターン（StatusManagerに倣う）。
 */
export class FileStateStore {
	private static instance: FileStateStore | undefined;
	private entries: Map<string, FileStateEntry> = new Map();
	private dirty = false;
	private loaded = false;
	private mdaitDir: string | undefined;

	private constructor() {}

	static getInstance(): FileStateStore {
		if (!FileStateStore.instance) {
			FileStateStore.instance = new FileStateStore();
		}
		return FileStateStore.instance;
	}

	static dispose(): void {
		FileStateStore.instance = undefined;
	}

	/** .mdait/file-state を読み込み */
	load(mdaitDir: string): void {
		this.mdaitDir = mdaitDir;
		this.entries.clear();
		this.dirty = false;

		const filePath = path.join(mdaitDir, FILE_STATE_FILENAME);
		if (!fs.existsSync(filePath)) {
			this.loaded = true;
			return;
		}

		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n");

		for (const line of lines) {
			// 空行・コメント行をスキップ
			if (line.trim() === "" || line.startsWith("#")) {
				continue;
			}

			const columns = line.split("\t");
			if (columns.length !== EXPECTED_COLUMN_COUNT) {
				logger.warn(
					"file-state",
					"Skipping malformed line (expected 4 columns)",
					{
						columnCount: columns.length,
						line: line.substring(0, 100),
					},
				);
				continue;
			}

			const [targetPath, hash, fromHash, need] = columns;
			this.entries.set(targetPath, {
				targetPath,
				hash,
				fromHash,
				need,
			});
		}

		this.loaded = true;
	}

	/** 変更があればファイルに書き戻し */
	save(mdaitDir: string): void {
		if (!this.dirty) {
			return;
		}

		const filePath = path.join(mdaitDir, FILE_STATE_FILENAME);

		// パスで昇順ソート
		const sortedEntries = [...this.entries.values()].sort((a, b) =>
			a.targetPath.localeCompare(b.targetPath),
		);

		const lines: string[] = [...HEADER_LINES];
		for (const entry of sortedEntries) {
			lines.push(
				`${entry.targetPath}\t${entry.hash}\t${entry.fromHash}\t${entry.need}`,
			);
		}

		// 末尾改行を付与
		const content = `${lines.join("\n")}\n`;
		fs.writeFileSync(filePath, content, "utf-8");
		this.dirty = false;
	}

	/**
	 * mdaitDirを設定し、未ロードの場合のみ読み込む。
	 * syncSingleFile等の単独トリガーで呼び出す。
	 */
	ensureLoaded(mdaitDir: string): void {
		this.mdaitDir = mdaitDir;
		if (!this.loaded) {
			this.load(mdaitDir);
		}
	}

	/** 遅延ロード: 未ロードならmdaitDirからauto-load（内部用） */
	private autoLoad(): void {
		if (!this.loaded && this.mdaitDir) {
			this.load(this.mdaitDir);
		}
	}

	getEntry(targetPath: string): FileStateEntry | undefined {
		this.autoLoad();
		return this.entries.get(targetPath);
	}

	setEntry(entry: FileStateEntry): void {
		this.autoLoad();
		this.entries.set(entry.targetPath, entry);
		this.dirty = true;
	}

	removeEntry(targetPath: string): void {
		this.autoLoad();
		if (this.entries.delete(targetPath)) {
			this.dirty = true;
		}
	}

	/** need != '' のエントリ一覧 */
	getEntriesNeedingAction(): FileStateEntry[] {
		this.autoLoad();
		return [...this.entries.values()].filter((e) => e.need !== "");
	}

	/** 全エントリを返す */
	getAllEntries(): FileStateEntry[] {
		this.autoLoad();
		return [...this.entries.values()];
	}

	/**
	 * validTargetPaths に含まれないエントリを削除する。
	 * extensions設定変更後の残留エントリクリーンアップ用。
	 * @returns 削除されたエントリ数
	 */
	cleanupOrphans(validTargetPaths: Set<string>): number {
		this.autoLoad();
		let removed = 0;
		for (const key of [...this.entries.keys()]) {
			if (!validTargetPaths.has(key)) {
				this.entries.delete(key);
				removed++;
			}
		}
		if (removed > 0) {
			this.dirty = true;
		}
		return removed;
	}
}
