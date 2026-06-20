/**
 * @file markers-migration.ts
 * @description
 *   マーカー保管方式を一括変換するコマンド。
 *   - externalize: 本文の埋め込みマーカーを `.mdait/unit-state` へ退避（embedded → external）
 *   - embed: unit-state のマーカーを本文へ書き戻す（external → embedded）
 *   変換は「現モードの provider で parse → 反対の provider で stringify」で行い、
 *   完了後に mdait.json の markers.mode を更新する。
 * @module commands/markers/markers-migration
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { markdownParser } from "../../core/markdown/parser";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../core/markdown/marker-provider";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";

const logger = Logger.getInstance();

/** 変換対象の MD ファイル（絶対パス + ロール） */
interface MigrationTarget {
	absPath: string;
	role: "source" | "target";
}

/**
 * 埋め込みマーカーを外部ストアへ退避する（embedded → external）。
 */
export async function externalizeMarkersCommand(): Promise<void> {
	await migrateMarkers("external");
}

/**
 * 外部ストアのマーカーを本文へ書き戻す（external → embedded）。
 */
export async function embedMarkersCommand(): Promise<void> {
	await migrateMarkers("embedded");
}

/**
 * 管理下の全 MD ファイル（source / target）を収集する。
 * 非MDファイルは対象外（unit-state の order:0 エントリは変換しない）。
 */
async function collectMarkdownTargets(config: Configuration): Promise<MigrationTarget[]> {
	const explorer = new FileExplorer();
	const targets: MigrationTarget[] = [];
	const seen = new Set<string>();
	const add = (absPath: string, role: "source" | "target") => {
		if (seen.has(absPath)) {
			return;
		}
		seen.add(absPath);
		targets.push({ absPath, role });
	};

	for (const pair of config.transPairs) {
		// .md のみ（extensions は渡さない）
		const sources = await explorer.getSourceFiles(pair.sourceDir, config);
		for (const src of sources) {
			add(src, "source");
			const tgt = explorer.getTargetPath(src, pair);
			if (tgt && fs.existsSync(tgt)) {
				add(tgt, "target");
			}
		}
	}
	return targets;
}

/**
 * マーカー保管方式を一括変換する中核処理。
 * @param toMode 変換先のモード
 */
async function migrateMarkers(toMode: "embedded" | "external"): Promise<void> {
	const config = Configuration.getInstance();
	if (!config.isConfigured()) {
		vscode.window.showErrorMessage(vscode.l10n.t("mdait is not configured in this workspace."));
		return;
	}

	const toExternal = toMode === "external";
	const confirmLabel = toExternal
		? vscode.l10n.t("Externalize markers")
		: vscode.l10n.t("Embed markers");
	const warnBody = toExternal
		? vscode.l10n.t(
				"This will move mdait markers out of all managed Markdown files into .mdait/unit-state. Manual sub-unit boundary markers (markers without a heading) are not supported in external mode and will be lost. Continue?",
			)
		: vscode.l10n.t(
				"This will write mdait markers from .mdait/unit-state back into all managed Markdown files. Continue?",
			);

	const choice = await vscode.window.showWarningMessage(warnBody, { modal: true }, confirmLabel);
	if (choice !== confirmLabel) {
		return;
	}

	const mdaitDir = await ensureMdaitDir();
	const store = UnitStateStore.getInstance();
	if (mdaitDir) {
		store.ensureLoaded(mdaitDir);
	}

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: toExternal
					? vscode.l10n.t("Externalizing mdait markers...")
					: vscode.l10n.t("Embedding mdait markers..."),
				cancellable: true,
			},
			async (progress, token) => {
				const targets = await collectMarkdownTargets(config);
				if (targets.length === 0) {
					return;
				}

				for (let i = 0; i < targets.length; i++) {
					if (token.isCancellationRequested) {
						vscode.window.showWarningMessage(
							vscode.l10n.t("Marker conversion cancelled. Some files may already be converted; re-run to finish."),
						);
						return;
					}
					const { absPath, role } = targets[i];
					progress.report({
						message: vscode.l10n.t("{0}/{1} files", i + 1, targets.length),
						increment: 100 / targets.length,
					});

					// 開いているエディタの未保存変更を反映してから読み込む
					await flushDirtyDocument(absPath);
					const content = fs.readFileSync(absPath, "utf-8");
					const ctx = { filePath: toWorkspaceRelativePath(absPath), role };

					if (toExternal) {
						// 埋め込み parse → 外部 stringify（store へ detach・本文からマーカー除去）
						const parsed = markdownParser.parse(content, config, embeddedMarkerProvider);
						const out = markdownParser.stringify(parsed, externalMarkerProvider, ctx);
						fs.writeFileSync(absPath, out, "utf-8");
					} else {
						// 外部 parse（store から attach）→ 埋め込み stringify（本文へ書き戻し）
						const parsed = markdownParser.parse(content, config, externalMarkerProvider, ctx);
						const out = markdownParser.stringify(parsed, embeddedMarkerProvider);
						fs.writeFileSync(absPath, out, "utf-8");
						// この MD ファイルの unit-state エントリを削除（非MDの order:0 は別パスなので影響なし）
						for (const entry of store.getEntriesByPath(ctx.filePath)) {
							store.removeEntry(ctx.filePath, entry.order);
						}
					}
				}

				// store を保存（external: 追加した detach、embedded: 削除を永続化）
				if (mdaitDir) {
					store.save(mdaitDir);
				}

				// mdait.json の markers.mode を更新（in-memory も即時反映）
				await setMarkerModeInConfigFile(config, toMode);
			},
		);
	} catch (error) {
		logger.error("markers", "Marker migration failed", formatError(error));
		vscode.window.showErrorMessage(
			vscode.l10n.t("Marker conversion failed: {0}", (error as Error).message),
		);
		return;
	}

	const doneMsg = toExternal
		? vscode.l10n.t("Markers externalized. Run Sync to verify the result.")
		: vscode.l10n.t("Markers embedded. Run Sync to verify the result.");
	vscode.window.showInformationMessage(doneMsg);
}

/**
 * mdait.json の markers.mode を書き換え、in-memory 設定も更新する。
 * JSON パースに失敗した場合はファイルを変更せず in-memory のみ更新する。
 */
async function setMarkerModeInConfigFile(config: Configuration, mode: "embedded" | "external"): Promise<void> {
	const configPath = config.getConfigFilePath();
	if (!configPath || !fs.existsSync(configPath)) {
		config.markers.mode = mode;
		return;
	}
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const json = JSON.parse(raw) as Record<string, unknown>;
		json.markers = { ...((json.markers as Record<string, unknown>) ?? {}), mode };
		fs.writeFileSync(configPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	} catch (error) {
		logger.warn("markers", "Failed to update markers.mode in mdait.json", formatError(error));
	}
	config.markers.mode = mode;
}
