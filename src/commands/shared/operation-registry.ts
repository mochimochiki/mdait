/**
 * @file operation-registry.ts
 * @description
 *   「いま何を処理中か」を持つ唯一の台帳。
 *
 *   これが無かった頃は (1) 多重起動を止める仕組みが無く、同じ対象への2回目の操作が
 *   FileMutex の待ち行列に並ぶだけで、利用者には「押したのに何も起きない」ように見え、
 *   (2) 進行中の表示（ツリーの回転アイコン）が StatusItem の `isTranslating` という
 *   書き込み可能な旗で表され、分岐ごとの手書きの解除処理が漏れるたびに回りっぱなしに
 *   なっていた。
 *
 *   台帳は「登録されている＝処理中」だけを意味し、解除は必ず handle.release() の
 *   一経路を通る。表示側は台帳に問い合わせるだけで、旗を持たない。
 *
 *   VS Code 非依存（単体テスト可能）。
 * @module commands/shared/operation-registry
 */
import * as path from "node:path";
import { normalizeFileKey } from "../../infra/workspace/file-key";

/**
 * 台帳が扱う操作の種類。競合判定はこの種類ごとに行う（種類が違えば重ならない）。
 * 表示（回転アイコン）は種類を問わず「何か走っていれば処理中」とする。
 */
export type OperationKind = "translate" | "terms";

/** 操作が対象とする範囲 */
export type OperationScope = "unit" | "file" | "directory";

/** 台帳に登録する対象 */
export interface OperationTarget {
	kind: OperationKind;
	scope: OperationScope;
	/** 絶対パス。scope が directory ならディレクトリの絶対パス */
	path: string;
	/** scope が unit のときのユニットハッシュ */
	unitHash?: string;
}

/** 登録済み操作の解放権 */
export interface OperationHandle {
	readonly target: OperationTarget;
	/** 台帳から取り除く。多重呼び出しは無害 */
	release(): void;
}

/** 表示側からの問い合わせ */
export interface BusyQuery {
	/** 省略すると種類を問わず判定する（表示は「何か走っているか」だけを問う） */
	kind?: OperationKind;
	scope: OperationScope;
	path: string;
	unitHash?: string;
}

interface Entry {
	id: number;
	target: OperationTarget;
	/** 比較用に正規化したパス */
	key: string;
}

/**
 * 2つのパスが同一、または child が parent の配下かを判定する。
 * 単純な前方一致は `/docs/en` と `/docs/en-US` を取り違えるため、必ず区切り境界で比較する。
 */
function isSameOrUnder(child: string, parent: string): boolean {
	if (child === parent) {
		return true;
	}
	const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
	return child.startsWith(prefix);
}

/**
 * 実行中操作の台帳（シングルトン）。
 */
export class OperationRegistry {
	private static instance: OperationRegistry | undefined;

	private readonly entries: Entry[] = [];
	private nextId = 1;
	private readonly listeners = new Set<() => void>();

	private constructor() {}

	static getInstance(): OperationRegistry {
		if (!OperationRegistry.instance) {
			OperationRegistry.instance = new OperationRegistry();
		}
		return OperationRegistry.instance;
	}

	/** シングルトンを破棄する（主にテスト用） */
	static dispose(): void {
		OperationRegistry.instance = undefined;
	}

	/**
	 * 台帳の内容が変わったときに呼ばれる購読を登録する（表示の更新用）。
	 * @returns 購読解除関数
	 */
	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * 対象を登録して解放権を返す。すでに範囲が重なる操作が走っていれば undefined を返す。
	 *
	 * **undefined を返すことが多重起動の拒否そのもの**であり、呼び出し側は進捗表示を
	 * 開く前にこれを確かめる。取得できたら必ず finally で release() すること。
	 */
	acquire(target: OperationTarget): OperationHandle | undefined {
		if (this.findConflict(target)) {
			return undefined;
		}
		const entry: Entry = {
			id: this.nextId++,
			target,
			key: normalizeFileKey(target.path),
		};
		this.entries.push(entry);
		this.notify();

		let released = false;
		return {
			target,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				const index = this.entries.findIndex((e) => e.id === entry.id);
				if (index !== -1) {
					this.entries.splice(index, 1);
				}
				this.notify();
			},
		};
	}

	/**
	 * 指定対象が「処理中に見える」かを返す（表示専用）。
	 *
	 * 自分自身が登録されている場合に加え、**祖先ディレクトリ・親ファイルの操作**でも
	 * true を返す。ディレクトリ翻訳中に配下のファイル行が止まって見えるのを防ぐため。
	 */
	isBusy(query: BusyQuery): boolean {
		const key = normalizeFileKey(query.path);
		return this.entries.some((entry) => {
			if (query.kind !== undefined && entry.target.kind !== query.kind) {
				return false;
			}
			if (entry.target.scope === "directory") {
				// ディレクトリ操作は配下すべてを処理中に見せる
				return isSameOrUnder(key, entry.key);
			}
			if (query.scope === "directory") {
				// ディレクトリ行は配下のファイル・ユニット操作でも回す
				return isSameOrUnder(entry.key, key);
			}
			if (entry.key !== key) {
				return false;
			}
			if (query.scope === "file") {
				// ファイル行は配下ユニットの操作でも回す
				return true;
			}
			// ユニット行は、ファイル全体の操作か自分自身の操作のときだけ回す
			return entry.target.scope === "file" || entry.target.unitHash === query.unitHash;
		});
	}

	/** 登録中の操作数（デバッグ・テスト用） */
	get size(): number {
		return this.entries.length;
	}

	/**
	 * 範囲が重なる登録済み操作を探す。
	 *
	 * 「重なる」の定義はファイル単位。同じファイルへの操作は、ユニットが違っても
	 * 重なりとみなす — ファイルは丸ごと読み書きされるため、並行させても FileMutex で
	 * 直列化されるだけで、待たされた側は古い解析結果を握ったまま「ユニットが見つからない」
	 * で終わる。待たせるより断る方が正直である。
	 */
	private findConflict(target: OperationTarget): Entry | undefined {
		const key = normalizeFileKey(target.path);
		return this.entries.find((entry) => {
			if (entry.target.kind !== target.kind) {
				return false;
			}
			if (entry.target.scope === "directory" || target.scope === "directory") {
				return isSameOrUnder(key, entry.key) || isSameOrUnder(entry.key, key);
			}
			return entry.key === key;
		});
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
