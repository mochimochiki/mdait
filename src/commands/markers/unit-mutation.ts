/**
 * @file unit-mutation.ts
 * @description
 *   マーカー／ユニット状態を書き換える操作すべてが通る共通の入出力手順。
 *
 *   **新しいサーフェス（CodeLens・ツリー・LM Tool・コマンド）を足すとき、
 *   マーカーの読み書きを自分で書いてはならない。必ずここを通ること。**
 *   排他制御・未保存バッファの反映・ストア保存・ステータス更新はここにしか無く、
 *   1つでも欠けると「押したのにツリーが古いまま」（ux.md B-5 と同じ原因系）が再発する。
 *   実際、以前は CodeLens が独自に本文を書き換えていたため、frontmatter と非MDファイルの
 *   need 解除でステータス更新が呼ばれず、本文マーカーの更新は `sync.autoSyncOnSave` が
 *   有効なときにだけ偶然直る状態になっていた。
 *
 * @module commands/markers/unit-mutation
 */
import * as vscode from "vscode";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../../infra/config/configuration";
import { type MarkerIO, resolveMarkerIO } from "../../infra/config/marker-io";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";

/** 書き換え操作の結果が最低限持つべき情報 */
export interface UnitMutationResult {
	/** 1件以上の変更を行ったか。false のときファイル書き込み・ステータス更新は行われない */
	changed: boolean;
}

/** ファイルが原文側か訳文側かを判定する（ワークスペース未設定等は訳文扱い） */
export function resolveFileRole(absPath: string, config: Configuration): "source" | "target" {
	try {
		return new FileExplorer().isSourceFile(absPath, config) ? "source" : "target";
	} catch {
		return "target";
	}
}

/**
 * ファイル単位の書き換えを排他・整合つきで実行する（ファイル種別を問わない外側の層）。
 *
 * - 読み取り〜書き戻しの間は FileMutex で排他する（sync / trans との競合防止）
 * - エディタ上の未保存バッファを先にディスクへ反映する
 * - external マーカーでは unit-state ストアをロードし、変更時に保存する
 * - 変更があったときだけステータスを更新する（冪等性を保つため、無変更なら何もしない）
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param mutate 実際の書き換え。changed:false を返した場合は保存・更新を行わない
 */
export async function withFileMutation<T extends UnitMutationResult>(
	absPath: string,
	config: Configuration,
	mutate: () => Promise<T>,
): Promise<T> {
	if (config.isExternalMarkers()) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	let outcome: T | undefined;
	await FileMutex.getInstance().runExclusive([absPath], async () => {
		await flushDirtyDocument(absPath);
		outcome = await mutate();
	});

	// runExclusive は mutate を必ず実行するため undefined にはならない
	const result = outcome as T;

	if (result.changed) {
		if (config.isExternalMarkers()) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().save(mdaitDir);
			}
		}
		await StatusManager.getInstance().refreshFileStatus(absPath);
	}
	return result;
}

/** Markdown 書き換えの作業コンテキスト */
export interface MarkdownMutationContext {
	/** パース済みドキュメント。マーカーを直接変異させてよい */
	parsed: Markdown;
	/** external の書き戻しに使う provider / ctx */
	io: MarkerIO;
}

/**
 * Markdown ファイルの書き換えを実行する（`withFileMutation` の Markdown 版）。
 *
 * embedded / external の差異は `resolveMarkerIO` 経由の parse/stringify に乗ることで吸収する。
 * マーカー境界の探索はパーサーに委譲するため、コードブロック内のサンプルマーカーには
 * 誤マッチしない（生の正規表現探索は行わない）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param mutate パース済みドキュメントを変異させ、結果を返す。changed:true のときのみ書き戻す
 */
export async function withMarkdownMutation<T extends UnitMutationResult>(
	absPath: string,
	config: Configuration,
	mutate: (ctx: MarkdownMutationContext) => Promise<T> | T,
): Promise<T> {
	const role = resolveFileRole(absPath, config);

	return withFileMutation(absPath, config, async () => {
		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
		const io = resolveMarkerIO(config, absPath, role);
		const parsed = markdownParser.parse(content, config, io.provider, io.ctx);

		const result = await mutate({ parsed, io });

		if (result.changed) {
			const encoder = new TextEncoder();
			const updated = markdownParser.stringify(
				{ frontMatter: parsed.frontMatter, units: parsed.units },
				io.provider,
				io.ctx,
			);
			await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), encoder.encode(updated));
		}
		return result;
	});
}
