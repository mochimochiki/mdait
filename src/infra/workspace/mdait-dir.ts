import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../config/configuration";
import { Logger, formatError } from "../logging/logger";

/**
 * `.mdait/.gitignore` に必ず載っている行。
 * `unit-registry.broken` と `unit-state.broken` は、読み取りに傷があったときだけ横へ写す
 * 原本の避難先で、中身は壊れた回のスナップショットそのもの。共有するものではない。
 *
 * `reports/` は各コマンドの実行レポート。**個人の実行結果であって共有する資産ではない**
 * ので追跡しない（ADR-260907-07）。ファイル名が種類ごとに固定で、実行のたびに全文を
 * 上書きするため、共有すると2人が同じコマンドを走らせるだけで必ず競合する。
 */
const GITIGNORE_LINES = ["logs/", "reports/", "unit-registry.broken", "unit-state.broken"];

/** 行の見出し（.gitignore ならパターン、.gitattributes なら対象パス）を取り出す */
function leadingToken(line: string): string {
	return line.trim().split(/\s+/)[0] ?? "";
}

/**
 * 見出しがまだ無い行だけを書き足す。
 *
 * 既にある行には触らない — `logs/` のように利用者が書き換えていたら、
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
	// 書き足す行は、そのファイルがいま使っている改行に揃える。既定で LF を足すと、
	// CRLF のファイル（Windows の編集・git の `core.autocrlf`）が混在改行になる
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}${eol}`;
	fs.writeFileSync(filePath, `${prefix}${missing.join(eol)}${eol}`, "utf-8");
}

/**
 * かつて mdait が `.mdait/.gitattributes` へ書き出していた `merge=union` の対象。
 *
 * union は「競合を出さない代わりに黙って片方を捨てる」取引で、**SVN には最初から無い**。
 * 効いた先（翻訳メモリと用語集）では実際に片方が失われていた。外せば git も SVN も
 * 「競合マーカーの入ったファイル」だけを吐き、扱う入力が1種類に揃う（ADR-260911-01）。
 *
 * 用語集は `terms.filename` で名前を変えられるので、決め打ちにせず設定から解決する。
 * **既定の `terms.csv` も必ず対象に入れる** — mdait はそこだけを決め打ちで書いていたので、
 * 名前を変えた作業場にも `terms.csv merge=union` が残骸として残っている。
 */
function unionAttributeTargets(): Set<string> {
	const targets = new Set(["unit-state", "unit-registry", "translations.tmx", "terms.csv"]);
	try {
		targets.add(path.basename(Configuration.getInstance().getTermsFilePath()));
	} catch {
		// 設定がまだ読めない作業場では、既定の名前ぶんだけを外す
	}
	return targets;
}

/**
 * 既にある `.gitattributes` から、mdait が書いた `merge=union` の指定を外す。
 *
 * **消すのは `merge=union` というトークン1つだけ**で、行ごとではない。行に出所は
 * 書かれていないので、利用者が同じ指定を自分で書いていた場合も外れる（union を
 * 外すのが目的なので意図は一致する）。一方で `unit-state merge=union eol=lf` のように
 * 同じ行へ別の指定を並べている作業場では、**`eol=lf` は利用者のもの**なので残す。
 * 行ごと消すと、その指定が黙って失われる。
 *
 * 指定が1つも残らなかった行は落とし、ファイルに中身が無くなったらファイルごと消す。
 * 対象外の行（他人が書いた行）は1行も動かさない。
 */
function pruneUnionMergeAttributes(filePath: string): void {
	if (!fs.existsSync(filePath)) {
		return;
	}
	const existing = fs.readFileSync(filePath, "utf-8");
	const targets = unionAttributeTargets();
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingEol = existing.endsWith("\n");
	const kept: string[] = [];
	let changed = false;

	for (const line of existing.split(/\r?\n/)) {
		const tokens = line.trim().split(/\s+/).filter((token) => token !== "");
		if (tokens.length < 2 || !targets.has(tokens[0])) {
			kept.push(line);
			continue;
		}
		const specs = tokens.slice(1).filter((spec) => spec !== "merge=union");
		if (specs.length === tokens.length - 1) {
			kept.push(line); // この行に union は無かった（`merge=ours` などはそのまま）
			continue;
		}
		changed = true;
		if (specs.length > 0) {
			kept.push(`${tokens[0]} ${specs.join(" ")}`);
		}
	}

	if (!changed) {
		return; // 出来上がりが同じなら書かない（無用な差分を作らない）
	}
	// 末尾の空行は、行を落としたぶんだけ残る。書き戻す前に畳む
	while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
		kept.pop();
	}
	if (kept.length === 0) {
		fs.rmSync(filePath, { force: true });
		return;
	}
	fs.writeFileSync(filePath, `${kept.join(eol)}${hadTrailingEol ? eol : ""}`, "utf-8");
}

/**
 * .mdaitディレクトリを初期化する
 * ディレクトリが存在しない場合は作成し、.gitignore も自動生成する
 * 既に存在する場合でも、足りない行があれば書き足す（冪等性を保証）
 *
 * `.gitattributes` は**もう作らない**。既にある作業場からは `merge=union` の指定を外す
 * （ADR-260911-01）。合流の守りは union に依存せず、競合は「競合の解決」で解く。
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
		pruneUnionMergeAttributes(path.join(mdaitDir, ".gitattributes"));
	} catch (error) {
		// .gitignore/.gitattributes の手入れはベストエフォートなので警告のみ
		Logger.getInstance().warn(
			"mdait-dir",
			"failed to create .mdait/.gitignore or prune .mdait/.gitattributes",
			formatError(error),
		);
	}

	return mdaitDir;
}
