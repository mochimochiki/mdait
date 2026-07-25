/**
 * @file declare-isolate.ts
 * @description
 *   ユニットに need:isolate を宣言する（凍結宣言。ADR-260711-05 の isolate モデルに従い、
 *   以後 sync は hash/from のみ更新し revise を流さない＝下流伝播を止める）。UX-R1: isolate 宣言UI。
 *   訳文・原文の両方に使える（原文側は sync が need:translate を生成しなくなる。ADR-260706-02）。
 *   解除（undeclare）は resolve-need.ts の resolveNeedForFile(needs:["isolate"]) を再利用する
 *   （need 除去という点で既存の解決経路と同一のため、新規実装しない）。
 * @module commands/markers/declare-isolate
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

export type DeclareIsolateSkipReason = "not-found" | "need-already-set";

export interface DeclareIsolateResult {
	declared: boolean;
	hash: string;
	title?: string;
	reason?: DeclareIsolateSkipReason;
}

/**
 * 指定ユニットに need:isolate を宣言する。
 * 既に何らかの need が付いている場合はスキップする（宣言操作が他の判断待ちを踏み潰さない安全弁）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param unitHash 宣言対象ユニットの hash
 * @param config 設定
 */
export async function declareIsolateForFile(
	absPath: string,
	unitHash: string,
	config: Configuration,
): Promise<DeclareIsolateResult> {
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

	let outcome: DeclareIsolateResult = { declared: false, hash: unitHash, reason: "not-found" };

	await FileMutex.getInstance().runExclusive([absPath], async () => {
		await flushDirtyDocument(absPath);

		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
		const io = resolveMarkerIO(config, absPath, role);
		const parsed = markdownParser.parse(content, config, io.provider, io.ctx);

		const unit = parsed.units.find((u) => u.marker?.hash === unitHash);
		if (!unit?.marker) {
			outcome = { declared: false, hash: unitHash, reason: "not-found" };
			return;
		}
		if (unit.marker.need) {
			outcome = { declared: false, hash: unitHash, reason: "need-already-set" };
			return;
		}

		unit.marker.setNeed("isolate");

		const encoder = new TextEncoder();
		const updatedContent = markdownParser.stringify(
			{ frontMatter: parsed.frontMatter, units: parsed.units },
			io.provider,
			io.ctx,
		);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), encoder.encode(updatedContent));

		outcome = { declared: true, hash: unitHash, title: unit.title };
	});

	if (outcome.declared) {
		if (config.isExternalMarkers()) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().save(mdaitDir);
			}
		}
		await StatusManager.getInstance().refreshFileStatus(absPath);
	}

	logger.info("resolve", "Isolate declared", { file: absPath, hash: unitHash, declared: outcome.declared });
	return outcome;
}
