import * as fs from "node:fs";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { markdownParser } from "../../core/markdown/parser";
import { buildSentenceQueries } from "../../core/tm/tm-query";
import { recomputeTmWeights } from "../../core/tm/tm-optimize";
import { TmxStore } from "../../core/tm/tmx-store";
import { FileExplorer } from "../../utils/file-explorer";
import { Logger, formatError } from "../../utils/logger";
import { ensureMdaitDir } from "../../utils/mdait-dir";

const logger = Logger.getInstance();

export async function tmOptimizeCommand(): Promise<void> {
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
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t("TM Optimize"),
			},
			async () => {
				const mdaitDir = ensureMdaitDir();
				const tmxPath = config.getTmFilePath();
				const store = TmxStore.getInstance(tmxPath);
				const entries = [...store.entries.values()];
				if (entries.length === 0) {
					vscode.window.showInformationMessage(vscode.l10n.t("TM optimize skipped: no entries found."));
					return;
				}

				const fileExplorer = new FileExplorer();
				const sourceDirs = new Set(
					config.transPairs.filter((pair) => pair.sourceLang === config.primaryLang).map((pair) => pair.sourceDir),
				);
				const queries = new Set<string>();
				for (const sourceDir of sourceDirs) {
					const files = await fileExplorer.getSourceFiles(sourceDir, config);
					for (const file of files) {
						const content = fs.readFileSync(file, "utf-8");
						const parsed = markdownParser.parse(content, config);
						for (const unit of parsed.units) {
							const unitQueries = buildSentenceQueries(unit.content, config.primaryLang, 1);
							for (const query of unitQueries) {
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
				logger.info("tm.optimize", "TM optimize completed", {
					entryCount: entries.length,
					queryCount: queries.size,
					tmxPath,
					mdaitDir,
				});
				vscode.window.showInformationMessage(
					vscode.l10n.t("TM optimize completed: {0} entries reweighted.", entries.length),
				);
			},
		);
	} catch (error) {
		logger.error("tm.optimize", "TM optimize failed", formatError(error));
		vscode.window.showErrorMessage(vscode.l10n.t("TM optimize failed: {0}", (error as Error).message));
	}
}
