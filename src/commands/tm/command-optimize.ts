import * as fs from "node:fs";
import * as vscode from "vscode";
import { markdownParser } from "../../core/markdown/parser";
import { recomputeTmWeights } from "../../core/tm/tm-optimize";
import { buildSentenceQueries } from "../../core/tm/tm-query";
import { TmxStore } from "../../core/tm/tmx-store";
import { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";

const logger = Logger.getInstance();

/** TM最適化の結果 */
export interface TmOptimizeResult {
	/** 再重み付けしたTMエントリ数 */
	entryCount: number;
}

/**
 * TM の検索重みを再計算して保存する（UI を出さない中核処理）。
 *
 * 重みの再計算は純粋な計算で AI を呼ばない。TM 登録の後段で自動実行するため、
 * ユーザーに独立した操作として見せない（ADR-260802-02。以前は `✨TM最適化` として
 * パレットに常駐し、しかも AI を呼ばないのに ✨ が付いていた）。
 *
 * @returns 再重み付けしたエントリ数（対象なしなら 0）
 */
export async function optimizeTmWeights(config: Configuration): Promise<number> {
	if (!config.getTmEnabled()) {
		return 0;
	}
	const tmxPath = config.getTmFilePath();
	const store = TmxStore.getInstance(tmxPath);
	const entries = [...store.entries.values()];
	if (entries.length === 0) {
		return 0;
	}

	const fileExplorer = new FileExplorer();
	const sourceDirs = new Set(
		config.transPairs.filter((pair) => pair.sourceLang === config.primaryLang).map((pair) => pair.sourceDir),
	);
	const queries = new Set<string>();
	for (const sourceDir of sourceDirs) {
		// NOTE: TM optimize は Sentence Query ベースのため MD ファイルのみを対象とする。
		// 非 MD ファイル（trans.extensions で追加した .txt 等）はユニット分割されないため
		// クエリを構築できず、意図的に除外している。
		const files = await fileExplorer.getSourceFiles(sourceDir, config);
		for (const file of files) {
			const content = fs.readFileSync(file, "utf-8");
			// マーカー読取は resolveMarkerIO 経由（external でも同一挙動を保つ）
			const io = resolveMarkerIO(config, file, "source");
			const parsed = markdownParser.parse(content, config, io.provider, io.ctx);
			for (const unit of parsed.units) {
				for (const query of buildSentenceQueries(unit.content, config.primaryLang, 1)) {
					queries.add(query);
				}
			}
		}
	}

	const weights = recomputeTmWeights(entries, [...queries], config.primaryLang);
	for (const entry of entries) {
		entry.weight = weights.get(entry.tuid) ?? 1;
	}
	store.save(tmxPath);
	logger.info("tm.optimize", "TM weights recomputed", {
		entryCount: entries.length,
		queryCount: queries.size,
		tmxPath,
	});
	return entries.length;
}

/**
 * TM最適化コマンド（UI つき）。
 *
 * ユーザー導線からは外し（TM登録の後段で自動実行する）、デバッグIPC・テスト用に残す。
 */
export async function tmOptimizeCommand(): Promise<TmOptimizeResult | undefined> {
	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}
	if (!config.getTmEnabled()) {
		vscode.window.showInformationMessage(vscode.l10n.t("TM feature is disabled. Enable it in mdait.json."));
		return;
	}

	try {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t("TM Optimize"),
			},
			async () => {
				ensureMdaitDir();
				const entryCount = await optimizeTmWeights(config);
				if (entryCount === 0) {
					vscode.window.showInformationMessage(vscode.l10n.t("TM optimize skipped: no entries found."));
					return { entryCount: 0 };
				}
				vscode.window.showInformationMessage(
					vscode.l10n.t("TM optimize completed: {0} entries reweighted.", entryCount),
				);
				return { entryCount };
			},
		);
	} catch (error) {
		logger.error("tm.optimize", "TM optimize failed", formatError(error));
		vscode.window.showErrorMessage(vscode.l10n.t("TM optimize failed: {0}", (error as Error).message));
		return undefined;
	}
}
