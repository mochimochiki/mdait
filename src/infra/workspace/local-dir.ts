import * as path from "node:path";

/**
 * `.mdait/` の中で、**コミットしない（共有しない）ものをまとめて置くディレクトリ**の名前。
 *
 * ここへ置くのは「この手元だけのもの」で、`.mdait/.gitignore` は `local/` の1行で済む。
 * 置くものが増えても `.gitignore` を書き足して回らずに済むよう、1か所へ集めている（ADR-260923-06）。
 *
 * - `reports/` … 各コマンドの実行レポート（走らせれば作り直せる）
 * - `logs/` … AI 呼び出しの統計・詳細ログ（消すと戻らない）
 * - `unit-state.held` … 本文から消えた章の状態の控えと、合流で降ろされた行（消しても訳は守られる）
 * - `unit-state.broken` / `unit-registry.broken` … 読み取りに傷があったときの原本の避難先（消すと戻らない）
 *
 * 名前を `temp` にしなかったのは、消すと戻らないもの（ログ・避難先）も入るからである。
 * 共通するのは「一時的」ではなく「共有しない」という性質である。
 */
export const LOCAL_DIRNAME = "local";

/**
 * `.mdait/local/` の中のパスを組み立てる。
 *
 * @param mdaitDir `.mdait` ディレクトリの絶対パス
 * @param segments `local/` からの相対パス
 */
export function localPath(mdaitDir: string, ...segments: string[]): string {
	return path.join(mdaitDir, LOCAL_DIRNAME, ...segments);
}
