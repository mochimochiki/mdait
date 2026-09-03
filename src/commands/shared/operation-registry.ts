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
 *   ## 排他の単位と、表示の単位は違う（ADR-260803-02）
 *
 *   この2つを1つの登録で兼ねると必ず壊れる。排他は粗くてよい（ファイルは丸ごと
 *   読み書きされるので、同じファイルへの操作はユニットが違っても重なりとみなす）が、
 *   表示は「いま実際に手が動いている行」だけを回さなければ利用者に進み具合が伝わらない。
 *   兼ねていた頃は、表示側が「ファイル操作が登録されている＝配下ユニットは全部処理中」と
 *   **下向きに推測**しており、11ユニットのファイルを訳すと 1件目の時点で 11件すべてが
 *   回り始め、訳し終えたユニットも回り続けた。推測は進行の実態と無関係なので、
 *   何件目を処理中かを表現しようがない。
 *
 *   そこで登録を2種類に分ける:
 *   - {@link OperationRegistry.acquire} … 排他つきの登録。重なる操作を断る根拠になる
 *   - {@link OperationRegistry.track} … 表示専用の登録。いま手が動いている行そのもの
 *
 *   そのうえで表示規則を1つに畳む — **登録された行と、その祖先だけが回る**。
 *   下向きの推測は一切しない。粒度は「実際に処理する関数が自分の区間を track する」
 *   ことだけから生まれるので、進行の実態と表示がずれない。
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

/**
 * 操作が対象とする範囲。ツリーの行の種類（ディレクトリ・ファイル・frontmatter・ユニット）と
 * 1対1で対応させる — 表示規則が「登録された行が回る」である以上、登録できる単位が
 * 行の単位と食い違うと、その行はもう正確に表せない。
 */
export type OperationScope = "unit" | "frontmatter" | "file" | "directory";

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
	/** 多重起動の拒否に使う登録か（false は表示専用） */
	exclusive: boolean;
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
		return this.register(target, true);
	}

	/**
	 * 「いま手が動いている行」を表示のためだけに登録する。**必ず登録できる**。
	 *
	 * 排他は {@link acquire} が済ませた前提で、その内側の進行位置を表すために使う。
	 * ディレクトリ翻訳がファイルを1つ処理し始めた、ファイル翻訳が1ユニットに着手した、
	 * といった区間の開始で呼び、区間の終わりで release する。
	 *
	 * これを使わずに「ファイルが登録されているなら配下ユニットも処理中だろう」と
	 * 表示側で推測すると、進み具合が表せない（全ユニットが同時に回り出す）。
	 */
	track(target: OperationTarget): OperationHandle {
		return this.register(target, false);
	}

	/**
	 * 指定対象が「処理中に見える」かを返す（表示専用）。
	 *
	 * 規則はひとつ — **登録された行と、その祖先だけが回る**。
	 * 祖先を回すのは、ディレクトリやファイルが「配下で何かをしている最中」であることが
	 * 事実だからである。逆向き（登録から配下を推測する）は事実ではないので行わない。
	 */
	isBusy(query: BusyQuery): boolean {
		const key = normalizeFileKey(query.path);
		return this.entries.some((entry) => {
			if (query.kind !== undefined && entry.target.kind !== query.kind) {
				return false;
			}
			switch (query.scope) {
				case "directory":
					// 配下（自分自身を含む）で何かが登録されていれば回す
					return isSameOrUnder(entry.key, key);
				case "file":
					// そのファイルへの登録（ファイル自体・frontmatter・ユニット）で回す
					return entry.key === key;
				case "frontmatter":
					return entry.key === key && entry.target.scope === "frontmatter";
				case "unit":
					return (
						entry.key === key &&
						entry.target.scope === "unit" &&
						entry.target.unitHash === query.unitHash
					);
			}
		});
	}

	/** 登録中の操作数（デバッグ・テスト用） */
	get size(): number {
		return this.entries.length;
	}

	/** 台帳へ1件加え、解放権を返す */
	private register(target: OperationTarget, exclusive: boolean): OperationHandle {
		const entry: Entry = {
			id: this.nextId++,
			target,
			key: normalizeFileKey(target.path),
			exclusive,
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
	 * 範囲が重なる登録済み操作を探す。
	 *
	 * 「重なる」の定義はファイル単位。同じファイルへの操作は、ユニットが違っても
	 * 重なりとみなす — ファイルは丸ごと読み書きされるため、並行させても FileMutex で
	 * 直列化されるだけで、待たされた側は古い解析結果を握ったまま「ユニットが見つからない」
	 * で終わる。待たせるより断る方が正直である。
	 *
	 * 表示専用の登録（{@link track}）は数に入れない。あれは「いま手が動いている行」を
	 * 表すだけで、排他はすでに外側の acquire が済ませている。数に入れると、
	 * 自分の進行位置が自分の次の操作を断ってしまう。
	 */
	private findConflict(target: OperationTarget): Entry | undefined {
		const key = normalizeFileKey(target.path);
		return this.entries.find((entry) => {
			if (!entry.exclusive) {
				return false;
			}
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
