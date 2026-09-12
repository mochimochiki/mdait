/**
 * @file conflict-branch.ts
 * @description
 *   StatusTree の「競合の解決」の枝を組み立てる（roadmap-v04 P01）。
 *
 *   置き場は `docs/ux.md` §3.3 の表に従う。**気づき**はステータスバーの1行、
 *   **状態と操作**はこの枝（1件1行）、**解説**は Hover（＝ツリー行のツールチップ）である。
 *   合流のたびにトーストは出さない（変化の気づきは1箇所に集約する）。
 *
 *   この段（P01）では**見せるだけ**で、行内の操作はまだ無い。解くのは P02（✨AI の一発）と
 *   P03（`こちらを採る` / `あちらを採る`）である。
 *
 * @module ui/status/conflict-branch
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { decisionOf } from "../../commands/conflict/conflict-decisions";
import type { PendingChoice, ResolutionPlan } from "../../commands/conflict/resolution-plan";
import { calculateHash } from "../../core/hash/hash-calculator";
import type { ConflictFileKind, MdaitConflicts } from "../../core/conflict/mdait-conflicts";
import { type DirectoryStatusItem, Status, StatusItemType } from "../../core/status/status-item";

/** ルート直下の「競合の解決」仮想ノードの識別子（実在するパスと衝突しない形にする） */
export const CONFLICTS_ID = "mdait:conflicts";

/** 枝の中の1行の識別子の接頭辞 */
const CONFLICT_ROW_PREFIX = "mdait:conflict:";

/** 競合したファイルの行の識別子（開くと、その中の1件1行が出る） */
const CONFLICT_FILE_PREFIX = `${CONFLICT_ROW_PREFIX}file:`;

/** そのファイルの中の1件を指す行の識別子 */
const CONFLICT_CHOICE_PREFIX = `${CONFLICT_ROW_PREFIX}choice:`;

/** その `directoryPath` が「競合の解決」の枝の中の行か */
export function isConflictRowId(directoryPath: string): boolean {
	return directoryPath.startsWith(CONFLICT_ROW_PREFIX);
}

/** その行が「競合したファイル」の行か（開くと中の1件が出る） */
export function isConflictFileRowId(directoryPath: string): boolean {
	return directoryPath.startsWith(CONFLICT_FILE_PREFIX);
}

/** ファイルの行の識別子から、そのファイルの絶対パスを取り出す */
export function filePathOfConflictRow(directoryPath: string): string | undefined {
	return directoryPath.startsWith(CONFLICT_FILE_PREFIX) ? directoryPath.slice(CONFLICT_FILE_PREFIX.length) : undefined;
}

/** 競合したファイルの、人が読む名前 */
function fileKindLabel(kind: ConflictFileKind): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t("Unit state");
		case "unit-registry":
			return vscode.l10n.t("Source snapshots");
		case "tm":
			return vscode.l10n.t("Translation memory");
		case "terms":
			return vscode.l10n.t("Glossary");
	}
}

/** 競合したファイルごとの、いま何が起きているかの解説（Hover） */
function fileKindExplanation(kind: ConflictFileKind): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t(
				"Two branches wrote different values for the same translation unit. mdait keeps every row it can read, so nothing is lost, but the conflict markers are still in the file.",
			);
		case "unit-registry":
			return vscode.l10n.t(
				"Two branches added different source snapshots. Snapshots are never chosen between — both sides are kept, because each one is a past version of a source document that exists nowhere else.",
			);
		case "tm":
			return vscode.l10n.t(
				"Two branches registered different translations. While the conflict markers are there, mdait refuses to read or save the translation memory, so nothing is overwritten.",
			);
		case "terms":
			return vscode.l10n.t(
				"Two branches edited the glossary. While the conflict markers are there, mdait refuses to read it, so AI translation runs without glossary terms until this is resolved.",
			);
	}
}

/**
 * 「競合の解決」の枝を作る。0件なら `undefined`（空のノードをツリーに出さない — UX-P7）。
 */
export function buildConflictsItem(conflicts: MdaitConflicts): DirectoryStatusItem | undefined {
	if (conflicts.total === 0) {
		return undefined;
	}
	return {
		type: StatusItemType.Directory,
		label: vscode.l10n.t("Merge conflicts ({0})", conflicts.total),
		status: Status.Error,
		directoryPath: CONFLICTS_ID,
		contextValue: "mdaitConflictsRoot",
		tooltip: vscode.l10n.t(
			"Merging left conflicts inside .mdait. Nothing has been lost, but mdait cannot use these files until the conflicts are resolved.",
		),
	};
}

/**
 * 枝の中の行を作る。**1件1行**で、何が読めるかは対象で決まる。
 *
 * - ファイル … 種別と、ワークスペースから見たパス
 * - 合流で降ろされた行 … 原稿のファイル名と、預かっている状態（`need` / `from`）
 */
export function buildConflictRows(
	conflicts: MdaitConflicts,
	workspaceRoot: string | undefined,
	/** 人が決める件の数（ファイルの絶対パス → 件数）。開けるかどうかの判断に使う */
	pendingCounts: ReadonlyMap<string, number> = new Map(),
): DirectoryStatusItem[] {
	const shortPath = (absolute: string) =>
		workspaceRoot ? path.relative(workspaceRoot, absolute).split(path.sep).join("/") : absolute;

	const fileRows = conflicts.files.map((file): DirectoryStatusItem => {
		const pending = pendingCounts.get(file.filePath) ?? 0;
		return {
			type: StatusItemType.Directory,
			label: fileKindLabel(file.kind),
			description:
				pending > 0
					? `${shortPath(file.filePath)} · ${vscode.l10n.t("{0} to decide", pending)}`
					: shortPath(file.filePath),
			status: Status.Error,
			directoryPath: `${CONFLICT_FILE_PREFIX}${file.filePath}`,
			contextValue: "mdaitConflictFile",
			tooltip: `${shortPath(file.filePath)}\n\n${fileKindExplanation(file.kind)}`,
		};
	});

	const heldRows = conflicts.heldRows.map((row, index): DirectoryStatusItem => ({
		type: StatusItemType.Directory,
		label: path.basename(row.path),
		description: row.need
			? vscode.l10n.t("held state: {0}", row.need)
			: vscode.l10n.t("held state: translated"),
		status: Status.Error,
		directoryPath: `${CONFLICT_ROW_PREFIX}held:${index}`,
		contextValue: "mdaitConflictHeldRow",
		tooltip: vscode.l10n.t(
			"{0}\n\nTwo branches wrote different states for the same chapter, so one of them was taken off its seat. It is kept, not discarded. Running Sync matches it against your documents: the side whose text matches goes back to its seat.",
			row.path,
		),
	}));

	return [...fileRows, ...heldRows];
}

/**
 * 競合したファイルを開いたときに出る、**1件1行**（roadmap-v04 P03）。
 *
 * 行には「こちらを採る」「あちらを採る」が付く（`package.json` の `viewItem` で引く）。
 * **✨は付けない** — AI を1回も呼ばないからである（UX-P4 の逆向き）。
 *
 * 既に決めた件は、どちらを採ったかを副題に出す。決めただけではまだ書かれていない
 * （そのファイルの最後の1件が決まったときにまとめて書く）ことも Hover に書く。
 */
export function buildConflictChoiceRows(plan: ResolutionPlan, stamp: string): DirectoryStatusItem[] {
	return plan.pending.map((item, index) => {
		const chosen = decisionOf(plan.filePath, stamp, item.key);
		return {
			type: StatusItemType.Directory,
			label: item.label,
			description: chosen
				? chosen === "ours"
					? vscode.l10n.t("your edit chosen")
					: vscode.l10n.t("their edit chosen")
				: vscode.l10n.t("not chosen yet"),
			status: Status.Error,
			directoryPath: `${CONFLICT_CHOICE_PREFIX}${index}:${fingerprintOfKey(item.key)}:${plan.filePath}`,
			contextValue: chosen ? "mdaitConflictChoiceDecided" : "mdaitConflictChoice",
			tooltip: buildChoiceTooltip(item, plan.kind, chosen),
		};
	});
}

/**
 * 行の識別子に載せる、その件の鍵の短い目印。
 *
 * 鍵そのものを載せないのは、長い（席のキーやハッシュ）からである。**番号だけでは足りない** —
 * ツリーに出したままファイルが外から変わると、同じ番号が別の件を指しうる。押した行が
 * いまも同じ件を指しているかは、この目印で確かめる。
 */
export function fingerprintOfKey(key: string): string {
	return calculateHash(key);
}

/**
 * 1件の解説（Hover）。
 *
 * **読む人はこの文を前触れなく初めて見る。** だから順に、何が起きたのか・両者が何を書いたのか・
 * 選ぶと何が起きるのか・いつ書き換わるのかを、この順で書く。「こちら」「あちら」のような
 * 指示語で始めない — 何を指しているのかが読み手に無いためである（`docs/ux.md` §3.3:
 * 解説はすべて Hover に置き、なぜこの状態なのかと次に何をすればよいかを書く）。
 */
function buildChoiceTooltip(
	item: PendingChoice,
	kind: ConflictFileKind,
	chosen: "ours" | "theirs" | undefined,
): string {
	const target = fileKindLabel(kind);

	// 1. 何が起きたのか。誰が何をしたかまで書く（「片方が」で済ませない）
	const happened = item.theirsDeleted
		? vscode.l10n.t(
				"You took in someone else's changes, and their edit collided with yours on this entry in the {0}. You rewrote it; they deleted it.",
				target,
			)
		: item.oursDeleted
			? vscode.l10n.t(
					"You took in someone else's changes, and their edit collided with yours on this entry in the {0}. You deleted it; they rewrote it.",
					target,
				)
			: vscode.l10n.t(
					"You took in someone else's changes, and two values arrived for the same entry in the {0}: the one you wrote and the one they wrote.",
					target,
				);

	// 2. 両者が書いたもの。消した側には値が無いので、値の代わりにそう書く
	const parts = [
		happened,
		"",
		`${vscode.l10n.t("You")}: ${item.oursDeleted ? vscode.l10n.t("(you deleted this entry)") : item.oursText}`,
		`${vscode.l10n.t("They")}: ${item.theirsDeleted ? vscode.l10n.t("(they deleted this entry)") : item.theirsText}`,
	];
	if (item.baseText !== undefined) {
		parts.push(`${vscode.l10n.t("Before either of you edited it")}: ${item.baseText}`);
	}

	// 3. 選ぶと何が起きるのか
	parts.push(
		"",
		item.theirsDeleted
			? vscode.l10n.t("Take your edit and the entry stays. Take theirs and the entry goes away.")
			: item.oursDeleted
				? vscode.l10n.t("Take your edit and the entry goes away. Take theirs and the entry stays.")
				: vscode.l10n.t("Choose which value to keep. The one you do not choose will not be there afterwards."),
	);

	// 4. いつ書き換わるのか
	parts.push(
		"",
		chosen
			? vscode.l10n.t(
					"You have chosen. Nothing has been written yet: this file is rewritten in one go, once every entry in it has been decided.",
				)
			: vscode.l10n.t(
					"Choosing writes nothing yet. This file is rewritten in one go, once every entry in it has been decided. No AI is involved.",
				),
	);
	return parts.join("\n");
}

/** 行の識別子から、そのファイルの絶対パス・何番目か・鍵の目印を取り出す */
export function choiceOfConflictRow(
	directoryPath: string,
): { filePath: string; index: number; fingerprint: string } | undefined {
	if (!directoryPath.startsWith(CONFLICT_CHOICE_PREFIX)) {
		return undefined;
	}
	const rest = directoryPath.slice(CONFLICT_CHOICE_PREFIX.length);
	const first = rest.indexOf(":");
	if (first < 0) {
		return undefined;
	}
	const second = rest.indexOf(":", first + 1);
	if (second < 0) {
		return undefined;
	}
	const index = Number.parseInt(rest.slice(0, first), 10);
	return Number.isInteger(index)
		? { filePath: rest.slice(second + 1), index, fingerprint: rest.slice(first + 1, second) }
		: undefined;
}
