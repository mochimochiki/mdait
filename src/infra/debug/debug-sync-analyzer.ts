/**
 * デバッグ専用: ステータスツリーの状態スナップショットと
 * fire イベント履歴を突合し、UI同期ズレを機械検出する。
 *
 * 核心:
 *   コマンド前後で「ファイルの状態が変わった」のに
 *   「その変更を通知する fire が飛んでいない / ディレクトリ通知のみ」
 *   というギャップを検出する。最終状態だけでは見逃す系を捕捉する。
 */

import * as path from "node:path";
import type { FileStatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import type { FireEvent } from "./debug-fire-recorder";

/** 1ファイルの状態シグネチャ（差分判定用） */
export type StateSnapshot = Record<string, string>;

/** 状態差分の1エントリ */
export interface StateDiffEntry {
	path: string;
	before: string | null;
	after: string | null;
}

/** 同期突合の結果 */
export interface SyncAnalysis {
	/** 状態が変化したファイル数 */
	changedFileCount: number;
	/** fire 総数 */
	fireCount: number;
	/**
	 * 状態は変化したが、その変更を直接通知する fire(file)が無かったファイル。
	 * = UIノードが古い表示のまま残る可能性が高い同期ギャップ。
	 */
	syncGaps: Array<{ path: string; reason: string }>;
}

/**
 * 現在の StatusItemTree から全ファイルの状態シグネチャを採取する。
 * tree 未構築・空でも安全に空スナップショットを返す。
 */
export function snapshotState(): StateSnapshot {
	const snapshot: StateSnapshot = {};
	try {
		const tree = StatusManager.getInstance().getStatusItemTree();
		for (const file of tree.getFilesAll()) {
			snapshot[file.filePath] = signatureOf(file);
		}
	} catch {
		// tree 未初期化など。空スナップショットで継続。
	}
	return snapshot;
}

/** ファイルの状態シグネチャ。表示に影響する主要フィールドを連結する。 */
function signatureOf(file: FileStatusItem): string {
	const needFlags = (file.children ?? [])
		.map((u) => u.needFlag ?? "-")
		.join(",");
	return [
		file.status,
		`t${file.translatedUnits}/${file.totalUnits}`,
		file.isTranslating ? "translating" : "idle",
		file.hasParseError ? "parseError" : "ok",
		`need[${needFlags}]`,
	].join("|");
}

/** before/after スナップショットの差分を算出する。 */
export function diffSnapshots(
	before: StateSnapshot,
	after: StateSnapshot,
): StateDiffEntry[] {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	const diffs: StateDiffEntry[] = [];
	for (const p of paths) {
		const b = before[p] ?? null;
		const a = after[p] ?? null;
		if (b !== a) {
			diffs.push({ path: p, before: b, after: a });
		}
	}
	return diffs;
}

/**
 * 状態差分と fire 履歴を突合し、同期ギャップを検出する。
 *
 * 判定:
 *   変更ファイル path に対し fire 履歴を走査し、
 *   - kind==="all"（全体更新）の fire があれば「通知済み」
 *   - path 完全一致の fire(file) があれば「通知済み」
 *   - ディレクトリ通知のみ（dir が path の親）なら「directory-only（ファイルノード未更新の懸念）」
 *   - いずれも無ければ「NOT-FIRED（同期ギャップ）」
 *
 * 補足（ADR-260724-01 以降）:
 *   ステータスツリーの通知は全体再描画（kind==="all"）に一本化されたため、通常の実行では
 *   1本目の判定で「通知済み」になる。本アナライザの実質的な役割は「状態が変わったのに
 *   fire が1つも観測されない」ケース（ツリーの変更メソッドを経由しない書き換え等）の検出に
 *   移った。path 一致・directory-only の判定は、部分通知を再導入した場合に備えて残している。
 */
export function analyzeSync(
	diffs: StateDiffEntry[],
	fires: FireEvent[],
): SyncAnalysis {
	const hasFullRefresh = fires.some((f) => f.kind === "all");
	const syncGaps: Array<{ path: string; reason: string }> = [];

	for (const diff of diffs) {
		if (hasFullRefresh) continue;

		const exactFire = fires.some((f) => f.path === diff.path);
		if (exactFire) continue;

		// path の親ディレクトリのみ通知されているか
		// 区切り文字を付与して "/ws/ja" が "/ws/ja-backup/a.md" に誤マッチするのを防ぐ
		const dirOnly = fires.some((f) => {
			if (f.kind !== "directory" || typeof f.path !== "string") return false;
			const dirPrefix = f.path.endsWith(path.sep) ? f.path : f.path + path.sep;
			return diff.path.startsWith(dirPrefix);
		});
		if (dirOnly) {
			syncGaps.push({
				path: diff.path,
				reason:
					"directory-only: ディレクトリ通知のみでファイルノード個別の fire が無い（表示が古いまま残る懸念）",
			});
		} else {
			syncGaps.push({
				path: diff.path,
				reason:
					"NOT-FIRED: 状態は変化したが、これを通知する fire が一切観測されなかった（同期ギャップ）",
			});
		}
	}

	return {
		changedFileCount: diffs.length,
		fireCount: fires.length,
		syncGaps,
	};
}
