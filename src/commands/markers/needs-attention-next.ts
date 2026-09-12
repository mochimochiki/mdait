import * as vscode from "vscode";
import type { NeedsAttentionItem } from "../../core/status/status-item";
import { getNeedsAttentionLine } from "../../core/status/status-item-tree";
import { StatusManager } from "../../core/status/status-manager";
import { Configuration } from "../../infra/config/configuration";
import { getSelectedScopeDirs } from "../shared/status-scope";

/** 「次の要対応へ」の探索起点 */
export interface NeedsAttentionOrigin {
	filePath: string;
	line: number;
}

/**
 * 「次の要対応へ」コマンド。
 *
 * 要対応キューは一覧があるだけでは連続裁定にならず、1件裁定するたびにツリーへ戻る往復が
 * 残る（ux.md B-8）。本コマンドは現在位置の次の項目へ1操作で移動し、末尾まで来たら先頭へ
 * 回ることでキューを一巡できるようにする。
 *
 * 押したときだけ動く。裁定の直後に自動で進むのは CodeLens「レビュー完了」だけで、
 * それは `advanceAfterReview` が受け持つ（ADR-260912-03）。
 *
 * 移動先は訳文だけでなく原文と並べて開く（`mdait.openPair`）。要対応の中心は review で、
 * 「この訳がこの原文の訳として正しいか」は対訳で見えないと判断できない。
 * frontmatter と非Markdown は行を持たないのでファイル先頭（0 行目）で開く。
 *
 * @param arg 呼び出し元が渡す第1引数。**型は決めつけない。** この ID はツリー行の
 *   インライン／右クリックからも呼ばれ、そのとき VS Code はツリー項目（StatusItem）を
 *   第1引数に渡す。`Range` と決めて `arg.start.line` を読むと、ツリーから押した瞬間に
 *   TypeError で落ちる（実測。エディタが1つでも開いていれば必ず）。
 *   `start.line` が数値のもの（Range 相当）だけを起点の行として使い、それ以外
 *   （ツリー項目・undefined）は無視してカーソル位置を起点にする。
 */
export async function needsAttentionNextCommand(arg?: unknown): Promise<void> {
	const items = collectSortedNeedsAttentionItems();

	if (items.length === 0) {
		// 「要対応」= review / verify-deletion のみ。need:translate は含まれないため、
		// 「対応すべきものは何もない」と誤読されない文言で何を調べたかを明示する。
		vscode.window.showInformationMessage(
			vscode.l10n.t("No units are awaiting review or deletion verification."),
		);
		return;
	}

	await openNeedsAttentionItem(items, findNextIndex(items, resolveOrigin(readOriginLine(arg))));
}

/**
 * need 解除の結果が「レビュー完了」（`need:review` を外した）だったかを判定する（純関数）。
 *
 * 同じ確定ボタンでも、翻訳済み・改訂済み・isolate 解除は要対応キューの外の操作なので、
 * 押したあとに別のファイルへ飛ばれると驚く。次へ進むのは review を片づけたときだけ。
 *
 * @param resolved `resolveNeed` が返した解決済みユニット（`need` は外したフラグの生値）
 */
export function isReviewResolution(resolved: ReadonlyArray<{ need: string }>): boolean {
	return resolved.some((unit) => unit.need === "review");
}

/**
 * CodeLens「レビュー完了」の直後に、残っている次の要対応へ進む（ADR-260912-03）。
 *
 * 要対応をキューとして回るとき、1件ごとに「次の要対応へ」を押し直すのは往復と同じ手間で、
 * 裁定→移動を1操作にまとめてはじめて連続裁定になる。review 以外の確定
 * （`isReviewResolution` が false）では何もしない。
 *
 * `needsAttentionNextCommand` との違いは残りが 0 件のときだけ — 通知で遮らず、
 * ステータスバーに一言置いて終わる。いま1件片づけた人にとって「残りなし」は結果であって
 * 警告ではない（ux.md §3.3）。
 *
 * @param resolved `resolveNeed` が返した解決済みユニット
 * @param origin いま裁定した項目の位置（ファイルと行）。ここより後ろの項目を探す。
 *   裁定した項目はキューから消えているので（`resolveNeed` がステータスを更新済み）、
 *   同じ項目で足踏みすることはない。末尾なら先頭へ回る
 */
export async function advanceAfterReview(
	resolved: ReadonlyArray<{ need: string }>,
	origin: NeedsAttentionOrigin,
): Promise<void> {
	if (!isReviewResolution(resolved)) {
		return;
	}
	const items = collectSortedNeedsAttentionItems();
	if (items.length === 0) {
		vscode.window.setStatusBarMessage(vscode.l10n.t("Needs Attention: all done"), 4000);
		return;
	}
	await openNeedsAttentionItem(items, findNextIndex(items, origin));
}

/**
 * キューの `index` 番目の項目を対訳表示で開き、キューの何件目かをステータスバーに一時的に示す
 * （通知を増やさず視界の隅で進捗が分かるようにする）。
 */
async function openNeedsAttentionItem(items: NeedsAttentionItem[], index: number): Promise<void> {
	const target = items[index];

	await vscode.commands.executeCommand(
		"mdait.openPair",
		target.filePath,
		getNeedsAttentionLine(target),
	);

	vscode.window.setStatusBarMessage(
		vscode.l10n.t("Needs Attention: {0} of {1}", index + 1, items.length),
		4000,
	);
}

/**
 * 第1引数から起点の行を取り出す。`start.line` が数値（`vscode.Range` 相当）のときだけ
 * その行を返し、ツリー項目・undefined・その他は無視する（undefined）。
 *
 * `instanceof vscode.Range` で判定しないのは、判定を構造に留めれば単体テストで
 * vscode の実クラスが要らず、ツリー項目が来る経路を直接固定できるため。
 */
export function readOriginLine(arg: unknown): number | undefined {
	const line = (arg as { start?: { line?: unknown } } | undefined)?.start?.line;
	return typeof line === "number" ? line : undefined;
}

/**
 * 選択中の transPair に属する要対応項目を、ツリーと同じ順序で取得する
 */
function collectSortedNeedsAttentionItems(): NeedsAttentionItem[] {
	const config = Configuration.getInstance();
	return StatusManager.getInstance()
		.getStatusItemTree()
		.getNeedsAttentionUnits(getSelectedScopeDirs(config));
}

/**
 * 探索の起点を決める。呼び出し元が行を渡した場合はその行、
 * それ以外はアクティブエディタのカーソル位置を使う。
 */
function resolveOrigin(line: number | undefined): NeedsAttentionOrigin | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	return {
		filePath: editor.document.uri.fsPath,
		line: line ?? editor.selection.active.line,
	};
}

/**
 * 起点より後ろにある最初の項目を探す。見つからなければ先頭へ回る（末尾で行き止まりにしない）。
 *
 * items は `compareNeedsAttentionUnits`（ファイルパス昇順→開始行昇順）でソート済みである
 * ことを前提とし、比較規則もそれに一致させる（行は `getNeedsAttentionLine` で読む。
 * frontmatter と非Markdown は 0 行目扱いなので、そのファイルの先頭に居るときは
 * カーソルが 0 行目なら「もう通り過ぎた」として次へ進む）。
 */
export function findNextIndex(
	items: NeedsAttentionItem[],
	origin: NeedsAttentionOrigin | undefined,
): number {
	if (!origin) {
		return 0;
	}

	const found = items.findIndex((item) => {
		if (item.filePath !== origin.filePath) {
			return item.filePath > origin.filePath;
		}
		return getNeedsAttentionLine(item) > origin.line;
	});

	return found >= 0 ? found : 0;
}
