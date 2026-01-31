/**
 * Snapshot Store
 *
 * CRC32ハッシュの先頭3桁（000〜fff）でバケット化し、
 * 決定的な順序（バケット昇順＋エントリ昇順）で出力することでgit競合を軽減する。
 *
 * フォーマット:
 * - バケット行: `<3桁hex> ` (末尾スペース、payloadなし)
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
	// 8桁hex + スペース + 何か
	return /^[0-9a-f]{8} .+$/i.test(line);
}

/** パースエラー */
export class SnapshotParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotParseError";
	}
}

/**
 * Snapshot Store
 * インメモリでバケット構造を管理し、パース・シリアライズを担当
 */
export class SnapshotStore {
	/** bucketId(3桁hex) -> Map<hash(8桁), encodedContent> */
	private buckets = new Map<string, Map<string, string>>();

	/**
	 * バケット化形式の文字列をパースしてストアに読み込む
	 * @param content ファイル内容
	 * @throws SnapshotParseError 形式不正の場合
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
				// バケット行
				currentBucket = line.substring(0, 3).toLowerCase();
				if (!this.buckets.has(currentBucket)) {
					this.buckets.set(currentBucket, new Map());
				}
			} else if (isEntryLine(line)) {
				// エントリ行
				if (currentBucket === null) {
					throw new SnapshotParseError(`Line ${i + 1}: Entry found before any bucket line`);
				}

				const spaceIndex = line.indexOf(" ");
				const hash = normalizeHash(line.substring(0, spaceIndex));
				const encoded = line.substring(spaceIndex + 1);

				// ハッシュがバケットに属するか確認
				const expectedBucket = getBucketId(hash);
				if (expectedBucket !== currentBucket) {
					throw new SnapshotParseError(
						`Line ${i + 1}: Hash ${hash} should be in bucket ${expectedBucket}, but found in ${currentBucket}`,
					);
				}

				const bucketMap = this.buckets.get(currentBucket);
				if (bucketMap?.has(hash)) {
					throw new SnapshotParseError(`Line ${i + 1}: Duplicate hash ${hash}`);
				}
				bucketMap?.set(hash, encoded);
			} else {
				// 不正な行
				throw new SnapshotParseError(`Line ${i + 1}: Invalid line format: ${line.substring(0, 50)}...`);
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
	 * - バケット内エントリはハッシュ昇順
	 * @returns バケット化形式の文字列
	 */
	serialize(): string {
		const lines: string[] = [];

		// 全バケット（000〜fff）を昇順で出力
		for (let i = 0; i < 4096; i++) {
			const bucketId = i.toString(16).padStart(3, "0");

			// バケット行（空バケットも出力）
			lines.push(`${bucketId} `);

			// このバケットにエントリがあれば出力
			const entries = this.buckets.get(bucketId);
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
