/**
 * @file delete-unit.ts
 * @description
 *   verify-deletion 判定で「削除」を選んだユニットをドキュメントから除去するコマンド。
 *   hash/from の書き換えに留まる resolve-need.ts と異なり、ユニット（本文＋マーカー）自体を取り除く。
 *   embedded では本文から該当セクションが消え、external では unit-state ストアのエントリも整合させる
 *   （detachMarkers は 0..newLength-1 のみ order 振り直しで書き戻すため、配列が縮んだ分の末尾エントリを
 *   明示的に removeEntry で刈り取らないと古いエントリが残留する）。
 *   安全弁として need:verify-deletion のユニットのみを対象とする（任意ユニットの誤削除を防ぐ）。
 * @module commands/markers/delete-unit
 */
import * as vscode from "vscode";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger } from "../../infra/logging/logger";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";

const logger = Logger.getInstance();

export type DeleteUnitSkipReason = "not-found" | "not-verify-deletion";

export interface DeleteUnitResult {
	deleted: boolean;
	hash: string;
	title?: string;
	reason?: DeleteUnitSkipReason;
}

/**
 * 指定ユニットをファイルから削除する。need:verify-deletion のユニットのみ対象。
 *
 * - 読み取り〜書き戻しの間は FileMutex でファイル単位に排他する（sync/trans との競合防止）
 * - external では detach 後に残る末尾の古いエントリを removeEntry で除去する
 *
 * @param absPath 対象ファイルの絶対パス
 * @param unitHash 削除対象ユニットの hash
 * @param config 設定
 */
export async function deleteUnitFromFile(
	absPath: string,
	unitHash: string,
	config: Configuration,
): Promise<DeleteUnitResult> {
	if (config.isExternalMarkers()) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	let role: "source" | "target" = "target";
	try {
		role = new FileExplorer().isSourceFile(absPath, config) ? "source" : "target";
	} catch {
		// ワークスペース未設定等は target 扱い（resolve-need.ts と同じフォールバック）
	}

	let outcome: DeleteUnitResult = { deleted: false, hash: unitHash, reason: "not-found" };

	await FileMutex.getInstance().runExclusive([absPath], async () => {
		await flushDirtyDocument(absPath);

		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
		const io = resolveMarkerIO(config, absPath, role);
		const parsed = markdownParser.parse(content, config, io.provider, io.ctx);

		const index = parsed.units.findIndex((u) => u.marker?.hash === unitHash);
		if (index === -1) {
			outcome = { deleted: false, hash: unitHash, reason: "not-found" };
			return;
		}
		const target = parsed.units[index];
		if (target.marker?.need !== "verify-deletion") {
			outcome = { deleted: false, hash: unitHash, reason: "not-verify-deletion" };
			return;
		}

		const oldLength = parsed.units.length;
		const title = target.title;
		parsed.units.splice(index, 1);

		// external: detachMarkers は 0..newLength-1 のみ書き戻すため、末尾の旧エントリを刈り取る
		if (config.isExternalMarkers() && io.ctx?.filePath) {
			UnitStateStore.getInstance().removeEntry(io.ctx.filePath, oldLength - 1);
		}

		const encoder = new TextEncoder();
		const updatedContent = markdownParser.stringify(
			{ frontMatter: parsed.frontMatter, units: parsed.units },
			io.provider,
			io.ctx,
		);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), encoder.encode(updatedContent));

		outcome = { deleted: true, hash: unitHash, title };
	});

	if (outcome.deleted) {
		if (config.isExternalMarkers()) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().save(mdaitDir);
			}
		}
		await StatusManager.getInstance().refreshFileStatus(absPath);
		StatusManager.getInstance().notifyRootChanged();
	}

	logger.info("resolve", "Unit deleted", { file: absPath, hash: unitHash, deleted: outcome.deleted });
	return outcome;
}
