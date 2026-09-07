import { encodeUnitRegistry } from "./unit-registry-encoder";

/**
 * Unit Registry Store
 *
 * CRC32ハッシュの先頭4桁（0000〜ffff）で区画に分け、決定的な順序（区画の昇順＋
 * ハッシュの昇順）で書き出す。
 *
 * **区画の目印の行は、1つも控えの無い区画にも必ず置く。** 合流で新しい控えの行が
 * ぶつかるのは「両方の枝が同じ隙間へ差し込んだ」ときなので、隙間を細かく割るほど
 * ぶつからなくなる。実測（2000件の台帳へ両方が30件ずつ足す合流を20回）:
 *
 * | 区画の数 | 競合した回 | 骨格込みの寸法 |
 * |---|---|---|
 * | 4096（3桁） | 2/20 | 71 KB |
 * | 65536（4桁） | **0/20** | 351 KB |
 *
 * 骨格の重さと引き換えに、SVN 利用者が base64 の塊を手で解く場面を無くしている
 * （SVN にはリポジトリに置けるマージ指定が無いので、形式そのもので減らすしかない）。
 *
 * 1エントリは content（ユニット内容のスナップショット）と、任意の note（ユニットに
 * 紐づく人間/ツールのメタ情報）を持つ。both encoded（base64+gzip）。
 * - content: content-addressed で不変。revise の旧内容 diff に使う
 * - note: そのハッシュのユニットに追従する恒久メタ。sync が編集時に旧→新ハッシュへ移送する
 *
 * フォーマット（行はスペース区切り。encoded 値は base64 のため空白を含まない）:
 * - 区画の目印: `<4桁hex>`（それだけの行）
 * - content のみ: `<8桁hash> <encodedContent>`
 * - content + note: `<8桁hash> <encodedContent> <encodedNote>`
 * - note のみ（content 未登録）: `<8桁hash>  <encodedNote>`（content トークンは空）
 *
 * **読み取りは1行でも多く拾う。** ここに控えてある旧原文は、どこにも複製が無い唯一の原本で、
 * 失うと `need:revise@X` が永久に当てはめられなくなる。読めない行があっても読める行は残す
 * （かつては1行の重複で `parse` が例外を投げ、呼び出し側が空のストアで続けて**次の書き込みで
 * 控えが丸ごと消えていた** — 実測で `revise@` の戻り先が1件、跡形もなく消えた）。
 */

/** 1ハッシュのレジストリエントリ（値は encoded 文字列） */
export interface UnitRegistryEntry {
	/** ユニット内容のスナップショット（encoded）。未登録時は "" */
	content: string;
	/** ユニットに紐づくメタ note（encoded）。無い場合は undefined */
	note?: string;
}

/** 区画の数（ハッシュの先頭4桁hex） */
export const BUCKET_COUNT = 0x10000;

/** 区画の目印（4桁hex）を抽出 */
export function getBucketId(hash: string): string {
	return hash.substring(0, 4).toLowerCase();
}

/** ハッシュを正規化（小文字8桁） */
function normalizeHash(hash: string): string {
	return hash.toLowerCase();
}

/** 区画の目印の行かどうかを判定（4桁hex だけの行） */
function isBucketLine(line: string): boolean {
	return /^[0-9a-f]{4}$/i.test(line);
}

/** エントリ行かどうかを判定 */
function isEntryLine(line: string): boolean {
	// 8桁hex + スペース + 任意の文字列（空も可）
	return /^[0-9a-f]{8} /i.test(line);
}

/** git がマージで残す競合マーカーの行か（`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`） */
function isConflictMarkerLine(line: string): boolean {
	return /^(<{7}|\|{7}|={7}|>{7})(\s|$)/.test(line);
}

/**
 * 読み取れなかったものの内訳。すべて 0 なら、ファイルは丸ごと読めている。
 */
export interface UnitRegistryParseReport {
	/** 形が分からず読み飛ばした行数 */
	skipped: number;
	/** git の競合マーカーとして読み飛ばした行数 */
	conflictMarkers: number;
	/** 同じハッシュが2度以上出てきたので1つに畳んだ回数 */
	duplicates: number;
}

/** 傷なく読み切れたか */
export function isCleanParse(report: UnitRegistryParseReport): boolean {
	return report.skipped === 0 && report.conflictMarkers === 0 && report.duplicates === 0;
}

/**
 * Unit Registry Store
 * インメモリでバケット構造を管理し、パース・シリアライズを担当
 */
export class UnitRegistryStore {
	/** bucketId(3桁hex) -> Map<hash(8桁), UnitRegistryEntry> */
	private buckets = new Map<string, Map<string, UnitRegistryEntry>>();

	/**
	 * 区画分けされた文字列をパースしてストアに読み込む
	 * - 区画の目印の行（4桁hex だけの行）は読み飛ばす（区画はハッシュから決まる）
	 * - note 列（3つ目のトークン）は任意
	 *
	 * **例外は投げない。** 読めない行は読み飛ばし、読めた行はすべて残す。同じハッシュが
	 * 2度出てきたら畳む（content は content-addressed なので中身は同じはずで、食い違うなら
	 * 片方が壊れている。先に出たほうを採り、note は後から出た空でないほうを採る）。
	 * git の競合マーカーも読み飛ばす — マージの後始末が済んでいないファイルでも、
	 * 両方の陣営が書いた控えはどちらも拾える。
	 *
	 * @param content ファイル内容
	 * @returns 読み取れなかったものの内訳（すべて 0 なら丸ごと読めている）
	 */
	parse(content: string): UnitRegistryParseReport {
		this.buckets.clear();
		const report: UnitRegistryParseReport = { skipped: 0, conflictMarkers: 0, duplicates: 0 };

		if (!content.trim()) {
			return report;
		}

		// **CRLF でも同じに読む。** ファイルは LF で書き出すが、git の `core.autocrlf` は
		// 取り出すときに CRLF へ変えうる。`\n` だけで切ると行末の `\r` が payload に混ざり、
		// 旧形式のバケット行は「読めない行」に数えられて、傷が無いのに原本の避難が走る
		const lines = content.split(/\r?\n/);

		for (const line of lines) {
			// 空行はスキップ
			if (!line.trim()) {
				continue;
			}

			if (isBucketLine(line)) {
				// 区画の目印。区画はハッシュから決まるので、この行が何を名乗っていても
				// 読み取りには使わない（合流で行を引き離すためだけに置いてある）
				continue;
			}

			if (isConflictMarkerLine(line)) {
				report.conflictMarkers++;
				continue;
			}

			if (!isEntryLine(line)) {
				report.skipped++;
				continue;
			}

			// エントリ行: `<hash> <encContent>[ <encNote>]`
			// encoded 値は base64 のため空白を含まず、スペース分割で安全に列を切れる
			const parts = line.split(" ");
			const hash = normalizeHash(parts[0]);
			const encodedContent = parts[1] ?? "";
			const encodedNote = parts[2];

			const bucketId = getBucketId(hash);
			if (!this.buckets.has(bucketId)) {
				this.buckets.set(bucketId, new Map());
			}
			const bucketMap = this.buckets.get(bucketId);
			const existing = bucketMap?.get(hash);
			if (!existing) {
				bucketMap?.set(hash, { content: encodedContent, note: encodedNote || undefined });
				continue;
			}

			// 同じハッシュが2度以上。捨てずに畳む
			report.duplicates++;
			if (!existing.content && encodedContent) {
				existing.content = encodedContent;
			}
			// note は同じハッシュに別々のものが書かれうる（両陣営が別の note を付けた合流）。
			// **読んだ順で決めない** — 順で決めると、同じ競合を2人が別々に片付けたときに
			// 違うバイト列が出て、それがまた競合する。文字列の順で決めれば誰がやっても同じ
			if (encodedNote) {
				existing.note = existing.note && existing.note > encodedNote ? existing.note : encodedNote;
			}
		}

		return report;
	}

	/** 指定ハッシュのエントリを取得（存在しなければ生成前の undefined） */
	private getEntry(hash: string): UnitRegistryEntry | undefined {
		return this.buckets.get(getBucketId(normalizeHash(hash)))?.get(normalizeHash(hash));
	}

	/** 指定ハッシュのエントリを取得または生成する */
	private ensureEntry(hash: string): UnitRegistryEntry {
		const normalizedHash = normalizeHash(hash);
		const bucketId = getBucketId(normalizedHash);
		if (!this.buckets.has(bucketId)) {
			this.buckets.set(bucketId, new Map());
		}
		const bucket = this.buckets.get(bucketId);
		let entry = bucket?.get(normalizedHash);
		if (!entry) {
			entry = { content: "" };
			bucket?.set(normalizedHash, entry);
		}
		return entry;
	}

	/**
	 * content を挿入または更新（note は保持する）
	 * @param hash 8桁ハッシュ
	 * @param encoded エンコード済みコンテンツ
	 */
	upsert(hash: string, encoded: string): void {
		this.ensureEntry(hash).content = encoded;
	}

	/**
	 * 複数エントリの content を一括で挿入または更新
	 * @param entries [hash, encoded] のペア配列
	 */
	upsertMany(entries: [string, string][]): void {
		for (const [hash, encoded] of entries) {
			this.upsert(hash, encoded);
		}
	}

	/**
	 * content を取得
	 * @param hash 8桁ハッシュ
	 * @returns エンコード済みコンテンツ、存在しない場合はnull（note のみのエントリは "" を返す＝呼び出し側は falsy 判定で content 無しとして扱う）
	 */
	get(hash: string): string | null {
		return this.getEntry(hash)?.content ?? null;
	}

	/**
	 * note を取得（encoded）
	 * @param hash 8桁ハッシュ
	 * @returns エンコード済み note、無い場合はnull
	 */
	getNote(hash: string): string | null {
		return this.getEntry(hash)?.note ?? null;
	}

	/**
	 * note を設定または削除する（content は保持する）
	 * @param hash 8桁ハッシュ
	 * @param encodedNote エンコード済み note。null/undefined で削除
	 */
	setNote(hash: string, encodedNote: string | null | undefined): void {
		if (encodedNote) {
			this.ensureEntry(hash).note = encodedNote;
			return;
		}
		// note 削除: content も無ければエントリごと削除
		const entry = this.getEntry(hash);
		if (!entry) {
			return;
		}
		entry.note = undefined;
		if (entry.content === "") {
			this.buckets.get(getBucketId(normalizeHash(hash)))?.delete(normalizeHash(hash));
		}
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
	 * - 全区画（0000〜ffff）を昇順で出力し、区画の目印の行を必ず置く
	 * - 区画内のエントリはハッシュ昇順。note があれば3列目に付与
	 * @returns 区画分けされた文字列
	 */
	serialize(): string {
		const lines: string[] = [];

		for (let i = 0; i < BUCKET_COUNT; i++) {
			const bucketId = i.toString(16).padStart(4, "0");
			// 目印の行は**控えが1つも無い区画にも置く**。合流で行を引き離すのが仕事なので、
			// 中身のある区画にだけ置いたのでは隙間が割れない（クラスの説明を見よ）
			lines.push(bucketId);

			const entries = this.buckets.get(bucketId);
			if (!entries || entries.size === 0) {
				continue;
			}
			for (const hash of Array.from(entries.keys()).sort()) {
				const entry = entries.get(hash);
				if (!entry) {
					continue;
				}
				lines.push(entry.note ? `${hash} ${entry.content} ${entry.note}` : `${hash} ${entry.content}`);
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
