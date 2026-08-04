/**
 * @file file-type.ts
 * @description
 *   拡張子からファイル種別を判定する唯一の定義。
 *   `getFileHandler`（ハンドラのディスパッチ）と `unit-mutation`（状態の保存先判定）が
 *   同じ規則を使うために切り出している。両者で別々に拡張子を見ると、
 *   「ハンドラは plain として扱うのに保存側は md とみなす」といった食い違いが生まれる。
 * @module commands/file-handler/file-type
 */
import * as path from "node:path";

/** ファイルタイプ識別子 */
export type FileType = "md" | "plain";

/**
 * ファイルパスからファイル種別を判定する。
 * Markdown 以外はすべて「ファイル＝単一ユニット」の plain として扱う。
 */
export function resolveFileType(filePath: string): FileType {
	return resolveFileTypeFromExtension(path.extname(filePath));
}

/**
 * 拡張子（`.txt` のような先頭ドット付き）からファイル種別を判定する。
 *
 * パスではなく拡張子しか持たない場所（翻訳時の `TranslationContext.fileExtension` など）
 * のための入口。`path.extname(".txt")` は空文字を返すのでパス版には渡せない。
 * 規則そのものはここ1か所に置く。
 *
 * @param fileExtension 先頭ドット付きの拡張子。空文字（拡張子なし）は plain
 */
export function resolveFileTypeFromExtension(fileExtension: string): FileType {
	return fileExtension.toLowerCase() === ".md" ? "md" : "plain";
}

/**
 * このファイルの翻訳状態が `unit-state` ストアに載るかを返す。
 *
 * - 非Markdown: マーカーを本文に埋め込めないため、**マーカーモードに関わらず**常にストア
 * - Markdown: external モードのときだけストア（embedded では本文のマーカーが正）
 *
 * 書き換え後にストアを保存するかの判定に使う。ここを `isExternalMarkers()` だけで
 * 判定すると、embedded モードで非Markdownファイルの need 解除が永続化されず、
 * 再読み込みで need が復活する。
 *
 * @param filePath 対象ファイルの絶対パス
 * @param isExternalMarkers マーカー保管方式が external か
 */
export function isUnitStateBacked(filePath: string, isExternalMarkers: boolean): boolean {
	return isExternalMarkers || resolveFileType(filePath) === "plain";
}
