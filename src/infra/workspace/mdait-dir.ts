import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../config/configuration";
import { Logger, formatError } from "../logging/logger";

/**
 * `.mdait/.gitignore` に必ず載っている行。
 * `unit-registry.broken` は、控えの読み取りに傷があったときだけ横へ写す原本の避難先で、
 * 中身は壊れた回のスナップショットそのもの。共有するものではない。
 */
const GITIGNORE_LINES = ["logs/", "unit-registry.broken"];

/**
 * `.mdait/.gitattributes` に必ず載っている行。
 *
 * どちらも「1つのファイルへ全員が書き込む」形なので、ブランチをまたぐと同じ場所が動く。
 * union merge なら両方の陣営の行が残る — 残しすぎは次の sync / GC が正規形へ均すが、
 * **落とした行は取り返せない**（`unit-registry` の各行は、どこにも複製の無い旧原文である）。
 */
const GITATTRIBUTES_LINES = ["unit-state merge=union", "unit-registry merge=union"];

/** 行の見出し（.gitignore ならパターン、.gitattributes なら対象パス）を取り出す */
function leadingToken(line: string): string {
	return line.trim().split(/\s+/)[0] ?? "";
}

/**
 * 見出しがまだ無い行だけを書き足す。
 *
 * 既にある行には触らない — `unit-state merge=ours` のように利用者が書き換えていたら、
 * それは意図された指定なので、こちらの既定で上書きしない。
 */
function ensureLines(filePath: string, requiredLines: string[]): void {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
	const present = new Set(
		existing
			.split(/\r?\n/)
			.map(leadingToken)
			.filter((token) => token !== ""),
	);
	const missing = requiredLines.filter((line) => !present.has(leadingToken(line)));
	if (missing.length === 0) {
		return;
	}
	const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
	fs.writeFileSync(filePath, `${prefix}${missing.join("\n")}\n`, "utf-8");
}

/**
 * .mdaitディレクトリを初期化する
 * ディレクトリが存在しない場合は作成し、.gitignore・.gitattributes も自動生成する
 * 既に存在する場合でも、足りない行があれば書き足す（冪等性を保証）
 *
 * @returns .mdaitディレクトリの絶対パス。ワークスペースが見つからない場合はnull
 */
export async function ensureMdaitDir(): Promise<string | null> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return null;
	}

	const mdaitDir = Configuration.getInstance().getMdaitDir();

	try {
		// .mdaitディレクトリを作成（既に存在する場合は何もしない）
		if (!fs.existsSync(mdaitDir)) {
			fs.mkdirSync(mdaitDir, { recursive: true });
		}

		ensureLines(path.join(mdaitDir, ".gitignore"), GITIGNORE_LINES);
		ensureLines(path.join(mdaitDir, ".gitattributes"), GITATTRIBUTES_LINES);
	} catch (error) {
		// .gitignore/.gitattributes 作成失敗はベストエフォートなので警告のみ
		Logger.getInstance().warn(
			"mdait-dir",
			"failed to create .mdait/.gitignore or .gitattributes",
			formatError(error),
		);
	}

	return mdaitDir;
}
