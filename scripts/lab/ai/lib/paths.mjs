/*
 * この道具が使う既定の置き場所。
 *
 * lab（scripts/lab）の作業場が決まっていれば、その下に置く。決まっていなければ
 * これまでどおり shim の隣を使う。両方に散らばらないよう、判断はここ1か所に置く。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** scripts/lab/ai の絶対パス */
export const AI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * lab の作業場。環境変数 MDAIT_LAB_DIR で変えられる。
 * 決まっていなければ undefined を返す（呼び出し側が shim の隣へ落とす）。
 */
export function labDir() {
	const value = process.env.MDAIT_LAB_DIR;
	return value ? path.resolve(value) : undefined;
}

/**
 * 郵便受け（live モードで要求と答えをやり取りするディレクトリ）の既定の場所。
 * MDAIT_LAB_DIR があれば `<LAB_DIR>/mailbox`、無ければ `scripts/lab/ai/mailbox`。
 */
export function defaultMailbox() {
	const lab = labDir();
	return lab ? path.join(lab, "mailbox") : path.join(AI_DIR, "mailbox");
}
