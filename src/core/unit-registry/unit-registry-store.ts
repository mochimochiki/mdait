import { encodeUnitRegistry } from "./unit-registry-encoder";

/**
 * Unit Registry Store
 *
 * CRC32ハッシュの先頭3桁（000〜fff）でバケット化し、
 * 決定的な順序（バケット昇順＋エントリ昇順）で出力することでgit競合を軽減する。
 *
 * フォーマット:
 * - バケット行: `<3桁hex> ` (末尾スペース、payloadなし) ※旧形式、互換性のため残存
 * - 初期エントリ: `<3桁hex>00000 <encodeUnitRegistry("")>` (各バケットの先頭)
 * - エントリ行: `<8桁hash> <encoded_content>`
 */

/** バケットID（3桁hex）を抽出 */
export function getBucketId(hash: string): string {
	return hash.substring(0, 3).toLowerCase();
}

/** ハッシュを正規化（小文字8桁） */
function normalizeHash(hash: string): string {
	return hash.toLowerCase();
}

/** バケット行かどうかを判定 */
function isBucketLine(line: string): boolean {
	// 3桁hex + スペース + 何もない
	return /^[0-9a-f]{3} $/i.test(line);
}

/** エントリ行かどうかを判定 */
function isEntryLine(line: string): boolean {
	// 8桁hex + スペース + 任意の文字列（空も可）
	return /^[0-9a-f]{8} /i.test(line);
}

/** パースエラー */
export class UnitRegistryParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnitRegistryParseError";
	}
}

/**
 * Unit Registry Store
 * インメモリでバケット構造を管理し、パース・シリアライズを担当
 */
export class UnitRegistryStore {
	/** bucketId(3桁hex) -> Map<hash(8桁), encodedContent> */
	private buckets = new Map<string, Map<string, string>>();

	/**
	 * バケット化形式の文字列をパースしてストアに読み込む
	 * - 新形式: バケット行なし、エントリ行のみ（ハッシュから自動判定）
	 * - 旧形式: バケット行あり（後方互換性のため対応）
	 * @param content ファイル内容
	 * @throws UnitRegistryParseError 形式不正の場合
	 */
	parse(content: string): void {
		this.buckets.clear();

		if (!content.trim()) {
			return;
		}

		const lines = content.split("\n");
		let currentBucket: string | null = null;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// 空行はスキップ
			if (!line.trim()) {
				continue;
			}

			if (isBucketLine(line)) {
				// バケット行（旧形式との互換性）
				currentBucket = line.substring(0, 3).toLowerCase();
				if (!this.buckets.has(currentBucket)) {
					this.buckets.set(currentBucket, new Map());
				}
			} else if (isEntryLine(line)) {
				// エントリ行
				const spaceIndex = line.indexOf(" ");
				const hash = normalizeHash(line.substring(0, spaceIndex));
				const encoded = line.substring(spaceIndex + 1);

				// 初期エントリ（payload空）はスキップ
				const bucketId = getBucketId(hash);
				if (hash === `${bucketId}00000` && encoded.trim() === "") {
					// 初期エントリはストアに保存しない（serializeで自動生成される）
					continue;
				}

				// ハッシュからバケットIDを自動判定
				// 旧形式でバケット行があった場合は整合性チェック
				if (currentBucket !== null && bucketId !== currentBucket) {
					throw new UnitRegistryParseError(
						`Line ${i + 1}: Hash ${hash} should be in bucket ${bucketId}, but found in ${currentBucket}`,
					);
				}

				// 新形式の場合: currentBucketを自動設定
				if (currentBucket === null) {
					currentBucket = bucketId;
				}

				// バケットを作成（存在しなければ）
				if (!this.buckets.has(bucketId)) {
					this.buckets.set(bucketId, new Map());
				}

				const bucketMap = this.buckets.get(bucketId);
				if (bucketMap?.has(hash)) {
					throw new UnitRegistryParseError(`Line ${i + 1}: Duplicate hash ${hash}`);
				}
				bucketMap?.set(hash, encoded);

				// 次のバケットに移行する可能性があるのでリセット
				currentBucket = null;
			} else {
				// 不正な行
				throw new UnitRegistryParseError(`Line ${i + 1}: Invalid line format: ${line.substring(0, 50)}...`);
			}
		}
	}

	/**
	 * エントリを挿入または更新
	 * @param hash 8桁ハッシュ
	 * @param encoded エンコード済みコンテンツ
	 */
	upsert(hash: string, encoded: string): void {
		const normalizedHash = normalizeHash(hash);
		const bucketId = getBucketId(normalizedHash);

		if (!this.buckets.has(bucketId)) {
			this.buckets.set(bucketId, new Map());
		}

		this.buckets.get(bucketId)?.set(normalizedHash, encoded);
	}

	/**
	 * 複数エントリを一括で挿入または更新
	 * @param entries [hash, encoded] のペア配列
	 */
	upsertMany(entries: [string, string][]): void {
		for (const [hash, encoded] of entries) {
			this.upsert(hash, encoded);
		}
	}

	/**
	 * エントリを取得
	 * @param hash 8桁ハッシュ
	 * @returns エンコード済みコンテンツ、存在しない場合はnull
	 */
	get(hash: string): string | null {
		const normalizedHash = normalizeHash(hash);
		const bucketId = getBucketId(normalizedHash);
		return this.buckets.get(bucketId)?.get(normalizedHash) ?? null;
	}

	/**
	 * 指定されたハッシュのみを残し、他を削除（GC）
	 * @param activeHashes 残すハッシュのセット
	 */
	retainOnly(activeHashes: Set<string>): void {
		const normalizedActive = new Set<string>();
		for (const hash of activeHashes) {
			normalizedActive.add(normalizeHash(hash));
		}

		for (const [bucketId, entries] of this.buckets) {
			for (const hash of entries.keys()) {
				if (!normalizedActive.has(hash)) {
					entries.delete(hash);
				}
			}
			// 空になったバケットは削除
			if (entries.size === 0) {
				this.buckets.delete(bucketId);
			}
		}
	}

	/**
	 * 正規形でシリアライズ
	 * - 全バケット（000〜fff）を昇順で出力
	 * - 各バケットの先頭に初期エントリ（<bucketId>00000）を配置（payload空）
	 * - バケット内エントリはハッシュ昇順
	 * @returns バケット化形式の文字列
	 */
	serialize(): string {
		const lines: string[] = [];

		// 全バケット（000〜fff）を昇順で出力
		for (let i = 0; i < 4096; i++) {
			const bucketId = i.toString(16).padStart(3, "0");
			const initialHash = `${bucketId}00000`;

			// このバケットにエントリがあるか確認
			const entries = this.buckets.get(bucketId);
			const hasInitialEntry = entries?.has(initialHash);

			// 初期エントリ（<bucketId>00000）を追加
			// - 実エントリがない場合: payload空で出力（ファイルサイズ削減）
			// - 実エントリがある場合: スキップ（実エントリで上書き）
			if (!hasInitialEntry) {
				lines.push(`${initialHash} `);
			}

			// このバケットにエントリがあれば出力
			if (entries && entries.size > 0) {
				// エントリをハッシュ昇順でソート
				const sortedHashes = Array.from(entries.keys()).sort();
				for (const hash of sortedHashes) {
					const encoded = entries.get(hash);
					lines.push(`${hash} ${encoded}`);
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * ストア内のエントリ数を取得
	 */
	size(): number {
		let count = 0;
		for (const entries of this.buckets.values()) {
			count += entries.size;
		}
		return count;
	}

	/**
	 * ストアをクリア
	 */
	clear(): void {
		this.buckets.clear();
	}

	/**
	 * すべてのハッシュを取得
	 */
	keys(): string[] {
		const result: string[] = [];
		for (const entries of this.buckets.values()) {
			for (const hash of entries.keys()) {
				result.push(hash);
			}
		}
		return result;
	}
}
