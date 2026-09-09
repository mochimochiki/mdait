/**
 * 台帳の掃除が守るべき印（ハッシュ）を、**選択で絞らずに**原稿から集める。
 *
 * 控えはハッシュだけを鍵にした表で、どのファイルの控えかを持っていない。だから
 * 「消してよい」と言えるのは**ワークスペース全体を見たとき**だけで、翻訳者がその日
 * 対象言語を絞っていようが関係なく、全部の言語の原稿から印を集める必要がある。
 *
 * 集めるのは3か所に散っている。
 *
 * - `.mdait/unit-state`（呼び出し側が全行を渡す）: external の Markdown と、非 Markdown
 * - 原稿の中の埋め込みマーカー: embedded の Markdown。ここが本モジュールの担当
 * - frontmatter の `mdait.front`: 保管方式に関わらず原稿に載ることがある
 *
 * **多めに拾ってよい。** ここで集めるのは「消してはいけない」の一覧なので、余計に
 * 拾えば掃除が少し甘くなるだけである。取りこぼすと控えが消えて取り返せない。
 * だから解析はせず、`mdait` を含む行から8桁16進を全部さらう。
 *
 * VS Code API 非依存（単体テスト対象）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 走査に入らないフォルダ（原稿は入っていない） */
const SKIPPED_DIR_NAMES = new Set([".git", ".mdait", "node_modules"]);

/** 8桁16進（マーカーの hash / from / revise@X はすべてこの幅） */
const HASH_PATTERN = /\b[0-9a-f]{8}\b/gi;

export interface MarkerSweepResult {
	/** 守るべき印 */
	hashes: Set<string>;
	/** 読みに行って**失敗した**ディレクトリ。1つでもあれば掃除は見送る */
	unreadableDirs: string[];
	/** 読んだファイルの数（記録用） */
	filesRead: number;
}

/**
 * 1ファイル分の本文から、マーカーに載っている印をさらう。
 *
 * `mdait` を含む行だけを見る。埋め込みマーカー（`<!-- mdait aaaa1111 from:bbbb2222 -->`）も
 * frontmatter の行（`mdait.front: aaaa1111 from:bbbb2222`）も、どちらもこの条件に当たる。
 */
export function collectMarkerHashesFromText(text: string): string[] {
	const found: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes("mdait")) {
			continue;
		}
		const matches = line.match(HASH_PATTERN);
		if (matches) {
			for (const match of matches) {
				found.push(match.toLowerCase());
			}
		}
	}
	return found;
}

/**
 * 与えられたディレクトリの配下を全部読んで、マーカーの印を集める。
 *
 * **まだ無いディレクトリは失敗にしない。** 訳文をまだ1つも作っていない言語では
 * ふつうに起こるうえ、そこにファイルが無いなら守るべき印もそこには無い。
 * 失敗として数えるのは、在るのに読めなかったとき（権限・入出力）だけである。
 *
 * @param dirs 走査するディレクトリ（絶対パス）。config の**全** pair 分を渡すこと
 * @param extensions 管理下の拡張子（`.md` を含む。`.` から始まる形）
 */
export function sweepMarkerHashes(
	dirs: readonly string[],
	extensions: readonly string[],
): MarkerSweepResult {
	const hashes = new Set<string>();
	const unreadableDirs = new Set<string>();
	let filesRead = 0;
	const wanted = new Set(extensions.map((extension) => extension.toLowerCase()));

	const walk = (dir: string, top: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				unreadableDirs.add(top);
			}
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIR_NAMES.has(entry.name)) {
					walk(full, top);
				}
				continue;
			}
			if (!entry.isFile() || !wanted.has(path.extname(entry.name).toLowerCase())) {
				continue;
			}
			try {
				const text = fs.readFileSync(full, "utf-8");
				filesRead++;
				for (const hash of collectMarkerHashesFromText(text)) {
					hashes.add(hash);
				}
			} catch {
				unreadableDirs.add(top);
			}
		}
	};

	const visited = new Set<string>();
	for (const dir of dirs) {
		const resolved = path.resolve(dir);
		if (visited.has(resolved)) {
			continue;
		}
		visited.add(resolved);
		walk(resolved, dir);
	}

	return { hashes, unreadableDirs: [...unreadableDirs], filesRead };
}
