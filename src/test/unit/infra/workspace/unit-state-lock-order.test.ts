/**
 * @file unit-state-lock-order.test.ts
 * @description ストア（unit-state）を書き換える経路が、2つのロックを必ず
 * 「ストア → ファイル」の順で取ることを、ソースを走査して固定する。
 *
 * 順序を守らないと2つの壊れ方が起きる。
 *
 * 1. **ロックを取らない**: sync は開始直後に `load()` を無条件に呼び、表を丸ごと
 *    捨ててディスクから読み直す。その区間に割り込んだ書き換えは、読み捨てられるか
 *    上書きで消える。一括変換（markers-migration）はマーカーを本文から剥がしてから
 *    表へ移すため、消えると**本文にも表にも残らず復旧できない**。
 * 2. **逆の順序で取る**: ストアを持ってファイルを待つ側（sync）と、ファイルを持って
 *    ストアを待つ側とで待ち合いになり、どちらも永久に進まない。
 *
 * 呼び出し側の単体テストでは順序を見張れない（実行時に組み合わさって初めて起きる）ため、
 * `executed-command-ids.test.ts` と同じくソースを突き合わせる。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

/** リポジトリのルート（out/test/unit/infra/workspace から5つ上） */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const srcRoot = path.join(repoRoot, "src");

/**
 * ストアの読み書き区間を持つ経路。
 *
 * `trans` はここに載っていない。ストアの区間が FileMutex の**内側**にあり、
 * 素直にロックを足すと順序が逆転する。フォルダ翻訳の並列（既定3・最大8）を
 * 直列に落とさずに直すため、`load()` の側を割り込みに強くする方針を採った。
 */
const GUARDED_MODULES = [
	"commands/sync/sync-command.ts",
	"commands/markers/unit-mutation.ts",
	"commands/markers/markers-migration.ts",
	"commands/ai-review/review-core.ts",
];

function read(relPath: string): string {
	return fs.readFileSync(path.join(srcRoot, relPath), "utf-8");
}

/** ロックを取る呼び出しの、ファイル内での最初の位置（無ければ -1） */
function firstIndexOfAny(source: string, needles: readonly string[]): number {
	const found = needles
		.map((needle) => source.indexOf(needle))
		.filter((index) => index >= 0);
	return found.length === 0 ? -1 : Math.min(...found);
}

const STORE_LOCK_CALLS = ["acquireUnitStateLock(", "withUnitStateLock("];
const FILE_LOCK_CALLS = ["FileMutex.getInstance().runExclusive("];

suite("unit-state ロックの順序", () => {
	for (const relPath of GUARDED_MODULES) {
		test(`${relPath} はストア全体の排他を取っている`, () => {
			const source = read(relPath);
			assert.ok(
				firstIndexOfAny(source, STORE_LOCK_CALLS) >= 0,
				`${relPath} がストアを書き換えるのにロックを取っていない。sync の load() に割り込まれると、書き換えが無言で消える`,
			);
		});

		test(`${relPath} はストアのロックをファイルのロックより先に取っている`, () => {
			const source = read(relPath);
			const fileLockAt = firstIndexOfAny(source, FILE_LOCK_CALLS);
			if (fileLockAt < 0) {
				return; // ファイル単位の排他を使わない経路は順序の制約を持たない
			}
			const storeLockAt = firstIndexOfAny(source, STORE_LOCK_CALLS);
			assert.ok(
				storeLockAt < fileLockAt,
				`${relPath} がファイルのロックを先に取っている。ストアを持ってファイルを待つ sync と待ち合いになり、どちらも進まなくなる`,
			);
		});
	}

	test("ロックを取らずにストアを保存している経路が増えていないこと", () => {
		// `save()` はメモリの表をディスクへ書き出す。ロックの外で呼ぶと、
		// 別の処理が読み込み途中の表（欠けた表）をそのまま永続化しうる。
		const known = new Set([
			...GUARDED_MODULES,
			// trans: 上記のとおり別の方針で扱う。ここに残す理由は「見落としではない」ことを示すため
			"commands/trans/trans-command.ts",
			// 非MDファイル。1ファイル1行で、書き換えるのは自分の行だけ
			"commands/file-handler/plain-file-handler.ts",
		]);

		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "test") {
						walk(full);
					}
					continue;
				}
				if (!entry.name.endsWith(".ts")) {
					continue;
				}
				const rel = path.relative(srcRoot, full).split(path.sep).join("/");
				if (rel === "core/unit-state/unit-state-store.ts" || known.has(rel)) {
					continue;
				}
				const source = fs.readFileSync(full, "utf-8");
				if (/UnitStateStore\.getInstance\(\)\.save\(|\bstore\.save\(mdaitDir\b/.test(source)) {
					offenders.push(rel);
				}
			}
		};
		walk(srcRoot);

		assert.deepStrictEqual(
			offenders,
			[],
			"ストアを保存する経路が増えている。ロックの順序（ストア → ファイル）を決めてから、" +
				"このテストの既知リストに追加すること",
		);
	});
});
