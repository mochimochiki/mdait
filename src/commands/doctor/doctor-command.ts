/**
 * @file doctor-command.ts
 * @description セットアップ診断コマンド（mdait.doctor）。
 * 純粋診断（setup-doctor）＋ AI 到達性チェックを実行し、結果をレポート文書と
 * アクション付き通知で提示する。初心者が「そもそも陥らない」ための最善導線。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	type Diagnostic,
	type DoctorConfigSnapshot,
	type DoctorProbe,
	hasBlockingError,
	runStaticChecks,
} from "../../core/diagnostics/setup-doctor";
import { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { openConfigInSettingsEditor } from "../shared/open-config-editor";

const TROUBLESHOOTING_URL =
	"https://github.com/mochimochiki/mdait/blob/main/docs/guide/ja/troubleshooting.md";

/**
 * セットアップ診断コマンドのエントリポイント。
 */
export async function diagnoseSetupCommand(): Promise<void> {
	const config = Configuration.getInstance();
	const baseDir = config.getConfigBaseDir();

	const snapshot: DoctorConfigSnapshot = {
		transPairs: config.transPairs.map((p) => ({
			sourceDir: p.sourceDir,
			targetDir: p.targetDir,
			sourceLang: p.sourceLang,
			targetLang: p.targetLang,
		})),
		primaryLang: config.primaryLang,
		aiProvider: config.ai.provider,
		// apiKey 直書き判定は「展開前の生値」で行う必要があるため設定ファイルから読む
		openaiApiKey: readRawOpenAiApiKey(config),
	};

	const diagnostics = runStaticChecks(snapshot, createFsProbe(baseDir));

	// AI 到達性（非同期 IO）は UI 層で追加実行する
	const aiDiag = await checkAiReachability(config);
	if (aiDiag) {
		diagnostics.push(aiDiag);
	}

	await presentDiagnostics(diagnostics, config);
}

/**
 * 設定ファイルから openai.apiKey の生値（${env:} 展開前）を読み出す。
 * 読めない/未設定なら undefined。
 */
function readRawOpenAiApiKey(config: Configuration): string | undefined {
	const configPath = config.getConfigFilePath();
	if (!configPath || !fs.existsSync(configPath)) {
		return undefined;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
		const apiKey = raw?.ai?.openai?.apiKey;
		return typeof apiKey === "string" ? apiKey : undefined;
	} catch {
		// 設定が壊れている場合は static チェック側で別途検出されるため無視
		return undefined;
	}
}

/** ディレクトリ存在判定 */
function directoryExists(absPath: string): boolean {
	try {
		return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
	} catch {
		// アクセス不能は「存在しない」とみなす
		return false;
	}
}

/**
 * 実ファイルシステムを走査する DoctorProbe を生成する。
 * 走査結果は相対パス単位でキャッシュし、Markdown 数とマーカー保有数を返す。
 */
function createFsProbe(baseDir: string): DoctorProbe {
	const cache = new Map<string, { md: number; withMarkers: number }>();
	const resolveDir = (rel: string): string =>
		path.isAbsolute(rel) ? rel : path.join(baseDir, rel);

	const scan = (rel: string): { md: number; withMarkers: number } => {
		const cached = cache.get(rel);
		if (cached) {
			return cached;
		}
		let md = 0;
		let withMarkers = 0;
		const walk = (dir: string, depth: number): void => {
			if (depth > 8) {
				return;
			}
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				// 読めないディレクトリはスキップ
				return;
			}
			for (const entry of entries) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) {
					continue;
				}
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full, depth + 1);
				} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
					md++;
					try {
						if (fs.readFileSync(full, "utf8").includes("<!-- mdait")) {
							withMarkers++;
						}
					} catch {
						// 読めないファイルはマーカー無し扱い
					}
				}
			}
		};
		const root = resolveDir(rel);
		if (directoryExists(root)) {
			walk(root, 0);
		}
		const result = { md, withMarkers };
		cache.set(rel, result);
		return result;
	};

	return {
		dirExists: (rel) => directoryExists(resolveDir(rel)),
		countMarkdownFiles: (rel) => scan(rel).md,
		countFilesWithMarkers: (rel) => scan(rel).withMarkers,
	};
}

/**
 * 設定された AI プロバイダの到達性を確認する。問題が無ければ undefined。
 * 例外は握りつぶし、診断は決して失敗させない。
 */
async function checkAiReachability(
	config: Configuration,
): Promise<Diagnostic | undefined> {
	const provider = config.ai.provider;
	try {
		switch (provider) {
			case "default":
			case "vscode-lm": {
				const vendor = config.ai.vendor ?? "copilot";
				const models = await vscode.lm.selectChatModels({ vendor });
				if (!models || models.length === 0) {
					return { level: "error", id: "ai.vscodeLmUnavailable" };
				}
				return undefined;
			}
			case "openai": {
				const resolved =
					(config.ai.openai?.apiKey as string) ||
					process.env.OPENAI_API_KEY ||
					"";
				if (!resolved) {
					return { level: "error", id: "ai.openaiKeyMissing" };
				}
				return undefined;
			}
			case "ollama": {
				const endpoint =
					config.ai.ollama?.endpoint ?? "http://localhost:11434";
				const reachable = await pingOllama(endpoint);
				if (!reachable) {
					return {
						level: "warn",
						id: "ai.ollamaUnreachable",
						params: { endpoint },
					};
				}
				return undefined;
			}
			default:
				return { level: "error", id: "ai.unknownProvider", params: { provider } };
		}
	} catch (error) {
		Logger.getInstance().warn("doctor", "AI reachability check failed", {
			error: String(error),
		});
		// vscode-lm 系は到達不能とみなして警告に倒す
		if (provider === "vscode-lm" || provider === "default") {
			return { level: "error", id: "ai.vscodeLmUnavailable" };
		}
		return undefined;
	}
}

/** Ollama エンドポイントへ短いタイムアウトで疎通確認する */
async function pingOllama(endpoint: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2000);
	try {
		const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`, {
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		// 接続不可
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** 診断 ID をユーザー向けメッセージへ変換する（l10n） */
function describe(d: Diagnostic): string {
	const p = d.params ?? {};
	switch (d.id) {
		case "config.noTransPairs":
			return vscode.l10n.t(
				"No translation pairs are configured (transPairs).",
			);
		case "pair.noSourceDir":
			return vscode.l10n.t("A translation pair is missing sourceDir.");
		case "pair.noTargetDir":
			return vscode.l10n.t("A translation pair is missing targetDir.");
		case "pair.sourceEqualsTarget":
			return vscode.l10n.t(
				"sourceDir and targetDir are the same ({0}). They must differ.",
				p.dir ?? "",
			);
		case "pair.nestedDirs":
			return vscode.l10n.t(
				"sourceDir and targetDir are nested ({0} / {1}). This can cause recursive processing.",
				p.source ?? "",
				p.target ?? "",
			);
		case "pair.sourceMissing":
			return vscode.l10n.t("Source directory does not exist: {0}", p.dir ?? "");
		case "pair.targetMissing":
			return vscode.l10n.t(
				"Target directory does not exist yet: {0} (Sync will create it).",
				p.dir ?? "",
			);
		case "pair.noMarkersRunSync":
			return vscode.l10n.t(
				"No mdait markers found in {0}. Run Sync first to start translation.",
				p.dir ?? "",
			);
		case "config.noPrimaryLang":
			return vscode.l10n.t(
				"Primary language (primaryLang) is not configured.",
			);
		case "config.primaryLangMismatch":
			return vscode.l10n.t(
				'primaryLang "{0}" does not match any translation pair language ({1}).',
				p.primaryLang ?? "",
				p.langs ?? "",
			);
		case "ai.apiKeyLiteral":
			return vscode.l10n.t(
				"OpenAI apiKey is written directly in mdait.json. Use the ${env:OPENAI_API_KEY} syntax to avoid leaking it through git.",
			);
		case "ai.vscodeLmUnavailable":
			return vscode.l10n.t(
				"No VS Code language model is available. Ensure GitHub Copilot is installed and enabled.",
			);
		case "ai.openaiKeyMissing":
			return vscode.l10n.t(
				"OpenAI API key is not set. Configure openai.apiKey or the OPENAI_API_KEY environment variable.",
			);
		case "ai.ollamaUnreachable":
			return vscode.l10n.t(
				"Could not reach the Ollama server at {0}.",
				p.endpoint ?? "",
			);
		case "ai.unknownProvider":
			return vscode.l10n.t("Unknown AI provider: {0}", p.provider ?? "");
		default:
			return d.id;
	}
}

/** レベルに応じたアイコン文字 */
function levelIcon(level: Diagnostic["level"]): string {
	switch (level) {
		case "error":
			return "❌";
		case "warn":
			return "⚠️";
		default:
			return "ℹ️";
	}
}

/**
 * 診断結果をレポート文書＋アクション付き通知で提示する。
 */
async function presentDiagnostics(
	diagnostics: Diagnostic[],
	config: Configuration,
): Promise<void> {
	const errorCount = diagnostics.filter((d) => d.level === "error").length;
	const warnCount = diagnostics.filter((d) => d.level === "warn").length;

	if (diagnostics.length === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("mdait setup looks good. No issues found."),
		);
		return;
	}

	// 詳細レポートを Markdown 文書として開く
	await openReport(diagnostics, errorCount, warnCount);

	// アクション付きサマリ通知
	const needsConfig = diagnostics.some(
		(d) => d.id.startsWith("config.") || d.id.startsWith("pair."),
	);
	const needsSync = diagnostics.some((d) => d.id === "pair.noMarkersRunSync");

	const openConfigLabel = vscode.l10n.t("Open mdait.json");
	const runSyncLabel = vscode.l10n.t("Run Sync");
	const docsLabel = vscode.l10n.t("Open docs");

	const actions: string[] = [];
	if (needsConfig) {
		actions.push(openConfigLabel);
	}
	if (needsSync) {
		actions.push(runSyncLabel);
	}
	actions.push(docsLabel);

	const summary = vscode.l10n.t(
		"mdait setup diagnosis: {0} error(s), {1} warning(s). See the report for details.",
		errorCount,
		warnCount,
	);

	const choice = hasBlockingError(diagnostics)
		? await vscode.window.showErrorMessage(summary, ...actions)
		: await vscode.window.showWarningMessage(summary, ...actions);

	if (choice === openConfigLabel) {
		await openConfigFile(config);
	} else if (choice === runSyncLabel) {
		await vscode.commands.executeCommand("mdait.sync");
	} else if (choice === docsLabel) {
		await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL));
	}
}

/** 診断レポートを読み取り用 Markdown 文書として開く */
async function openReport(
	diagnostics: Diagnostic[],
	errorCount: number,
	warnCount: number,
): Promise<void> {
	const lines: string[] = [];
	lines.push(`# ${vscode.l10n.t("mdait Setup Diagnosis")}`);
	lines.push("");
	lines.push(
		vscode.l10n.t(
			"Errors: {0}, Warnings: {1}, Info: {2}",
			errorCount,
			warnCount,
			diagnostics.length - errorCount - warnCount,
		),
	);
	lines.push("");
	for (const d of diagnostics) {
		lines.push(`- ${levelIcon(d.level)} ${describe(d)}`);
	}
	lines.push("");
	lines.push(`---`);
	lines.push(vscode.l10n.t("Troubleshooting guide: {0}", TROUBLESHOOTING_URL));

	const doc = await vscode.workspace.openTextDocument({
		content: lines.join("\n"),
		language: "markdown",
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}

/** 設定ファイルを設定UIで開く（無ければ作成コマンドへ） */
async function openConfigFile(config: Configuration): Promise<void> {
	const configPath = config.getConfigFilePath();
	if (configPath && fs.existsSync(configPath)) {
		await openConfigInSettingsEditor(configPath);
	} else {
		await vscode.commands.executeCommand("mdait.setup.createConfig");
	}
}
