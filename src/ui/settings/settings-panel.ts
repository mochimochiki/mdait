/**
 * mdait.json 設定エディタの WebviewPanel。
 * スキーマから生成したモデルと現在値を webview へ渡し、
 * webview からの変更要求をキー単位で mdait.json へ書き込む。
 * ロジック（検証・パス解決・ファイルI/O）はすべて拡張側にあり、webview は表示に徹する。
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { removeConfigValue, setConfigValue } from "./config-json-editor";
import {
	deriveSettingLabel,
	getCategoryDoc,
	getSettingDescription,
	getUiStrings,
} from "./settings-doc";
import {
	type JsonSchemaNode,
	type SettingDescriptor,
	buildSettingsModel,
} from "./settings-model";

/** webview へ渡す、解説を付与した設定ディスクリプタ */
interface LocalizedSettingDescriptor extends SettingDescriptor {
	label: string;
	localizedDescription: string;
}

interface LocalizedCategory {
	id: string;
	label: string;
	description: string;
	settings: LocalizedSettingDescriptor[];
}

/** 設定 ID → { 現在値, mdait.json にキーが存在するか } */
type SettingValues = Record<string, { value: unknown; present: boolean }>;

/** webview から受信するメッセージ */
type IncomingMessage =
	| { type: "ready" }
	| { type: "update"; id: string; value: unknown }
	| { type: "reset"; id: string }
	| { type: "openJson" };

export class SettingsPanel {
	public static readonly viewType = "mdait.settingsEditor";
	private static current: SettingsPanel | undefined;
	private static configListenerRegistered = false;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly descriptorById = new Map<string, SettingDescriptor>();
	private categories: LocalizedCategory[] = [];
	private disposed = false;

	/**
	 * 設定エディタを開く（既に開いていれば手前に表示する）。
	 * mdait.json が存在しない場合はパネルを開かず setup へ誘導する。
	 */
	public static createOrShow(context: vscode.ExtensionContext): void {
		const configPath = Configuration.getInstance().getConfigFilePath();
		if (!configPath || !fs.existsSync(configPath)) {
			const create = vscode.l10n.t("Create mdait.json");
			vscode.window
				.showInformationMessage(
					vscode.l10n.t(
						"mdait.json does not exist yet. Create it first to use the settings editor.",
					),
					create,
				)
				.then((choice) => {
					if (choice === create) {
						vscode.commands.executeCommand("mdait.setup.createConfig");
					}
				});
			return;
		}

		if (SettingsPanel.current) {
			SettingsPanel.current.panel.reveal();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			SettingsPanel.viewType,
			vscode.l10n.t("mdait Settings"),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, "assets"),
				],
				// スクロール位置・検索状態を保持する
				retainContextWhenHidden: true,
			},
		);
		SettingsPanel.current = new SettingsPanel(panel, context.extensionUri);

		// 外部編集（エディタでの直接編集・別コマンドによる書換）を反映する。
		// Configuration のコールバックは解除できないため、一度だけ登録して
		// 現在のパネルへルーティングする
		if (!SettingsPanel.configListenerRegistered) {
			SettingsPanel.configListenerRegistered = true;
			Configuration.getInstance().onConfigurationChanged(() => {
				SettingsPanel.current?.postValues();
			});
		}
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;

		this.buildModel();
		this.panel.webview.html = this.buildHtml();

		this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => {
			this.handleMessage(message);
		});
		this.panel.onDidDispose(() => {
			this.disposed = true;
			if (SettingsPanel.current === this) {
				SettingsPanel.current = undefined;
			}
		});
	}

	/** スキーマを読み込み、解説付きモデルを構築する */
	private buildModel(): void {
		const schemaUri = vscode.Uri.joinPath(
			this.extensionUri,
			"assets",
			"schemas",
			"mdait-config.schema.json",
		);
		const schema = JSON.parse(
			fs.readFileSync(schemaUri.fsPath, "utf8"),
		) as JsonSchemaNode;
		const model = buildSettingsModel(schema);

		this.categories = model.map((category) => {
			const doc = getCategoryDoc(category.id);
			return {
				id: category.id,
				label: doc.label,
				description: doc.description,
				settings: category.settings.map((setting) => {
					this.descriptorById.set(setting.id, setting);
					return {
						...setting,
						label: deriveSettingLabel(setting.id, setting.category),
						localizedDescription:
							getSettingDescription(setting.id) ?? setting.description,
					};
				}),
			};
		});
	}

	private handleMessage(message: IncomingMessage): void {
		try {
			switch (message.type) {
				case "ready":
					this.panel.webview.postMessage({
						type: "init",
						categories: this.categories,
						values: this.readValues(),
						strings: getUiStrings(),
					});
					break;
				case "update":
					this.applyUpdate(message.id, message.value);
					break;
				case "reset":
					this.applyReset(message.id);
					break;
				case "openJson": {
					const configPath = this.getConfigFilePath();
					vscode.window.showTextDocument(vscode.Uri.file(configPath));
					break;
				}
			}
		} catch (error) {
			Logger.getInstance().error(
				"settings-ui",
				"Failed to handle settings editor message",
				formatError(error),
			);
			this.panel.webview.postMessage({
				type: "error",
				message: (error as Error).message,
			});
			// UI と実ファイルの整合を取り直す
			this.postValues();
		}
	}

	private getConfigFilePath(): string {
		const configPath = Configuration.getInstance().getConfigFilePath();
		if (!configPath) {
			throw new Error(vscode.l10n.t("Workspace is not opened"));
		}
		return configPath;
	}

	/** mdait.json の現在値を設定 ID ごとに読み出す */
	private readValues(): SettingValues {
		const values: SettingValues = {};
		const configPath = this.getConfigFilePath();
		let root: Record<string, unknown> = {};
		try {
			root = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
				string,
				unknown
			>;
		} catch {
			// 構文エラー中の外部編集など。値は「未設定」として返し UI は既定値を表示する
			root = {};
		}
		for (const [id, descriptor] of this.descriptorById) {
			let node: unknown = root;
			let present = true;
			for (const key of descriptor.path) {
				if (
					node !== null &&
					typeof node === "object" &&
					!Array.isArray(node) &&
					key in (node as Record<string, unknown>)
				) {
					node = (node as Record<string, unknown>)[key];
				} else {
					present = false;
					break;
				}
			}
			values[id] = { value: present ? node : undefined, present };
		}
		return values;
	}

	/** 変更を型検証してから mdait.json に書き込む */
	private applyUpdate(id: string, rawValue: unknown): void {
		const descriptor = this.descriptorById.get(id);
		if (!descriptor) {
			throw new Error(`Unknown setting: ${id}`);
		}
		const configPath = this.getConfigFilePath();
		const text = fs.readFileSync(configPath, "utf8");
		const value = this.coerceValue(descriptor, rawValue, text);
		const updated = setConfigValue(text, descriptor.path, value);
		fs.writeFileSync(configPath, updated, "utf8");
		Logger.getInstance().info("settings-ui", "Setting updated", { id });
		this.postValues();
	}

	private applyReset(id: string): void {
		const descriptor = this.descriptorById.get(id);
		if (!descriptor) {
			throw new Error(`Unknown setting: ${id}`);
		}
		const configPath = this.getConfigFilePath();
		const text = fs.readFileSync(configPath, "utf8");
		const updated = removeConfigValue(text, descriptor.path);
		fs.writeFileSync(configPath, updated, "utf8");
		Logger.getInstance().info("settings-ui", "Setting reset", { id });
		this.postValues();
	}

	/** webview からの値をディスクリプタの型へ変換する。不正値は例外 */
	private coerceValue(
		descriptor: SettingDescriptor,
		rawValue: unknown,
		currentText: string,
	): unknown {
		switch (descriptor.type) {
			case "boolean":
				return rawValue === true || rawValue === "true";
			case "integer":
			case "number": {
				const num = Number(rawValue);
				if (!Number.isFinite(num)) {
					throw new Error(vscode.l10n.t("Invalid value"));
				}
				const value = descriptor.type === "integer" ? Math.floor(num) : num;
				if (
					(descriptor.minimum !== undefined && value < descriptor.minimum) ||
					(descriptor.maximum !== undefined && value > descriptor.maximum)
				) {
					throw new Error(vscode.l10n.t("Invalid value"));
				}
				return value;
			}
			case "enum": {
				const value = String(rawValue);
				if (!descriptor.enum?.includes(value)) {
					throw new Error(vscode.l10n.t("Invalid value"));
				}
				return value;
			}
			case "string":
				return String(rawValue);
			case "stringArray": {
				if (!Array.isArray(rawValue)) {
					throw new Error(vscode.l10n.t("Invalid value"));
				}
				return rawValue
					.map((item) => String(item).trim())
					.filter((item) => item.length > 0);
			}
			case "objectArray":
				return this.coerceObjectArray(descriptor, rawValue, currentText);
			default:
				throw new Error(vscode.l10n.t("Invalid value"));
		}
	}

	/**
	 * objectArray（transPairs）の行データを検証しつつ、
	 * UI 列に無いキー（copyAssets 等）を既存の同一行から引き継ぐ。
	 */
	private coerceObjectArray(
		descriptor: SettingDescriptor,
		rawValue: unknown,
		currentText: string,
	): unknown[] {
		if (!Array.isArray(rawValue)) {
			throw new Error(vscode.l10n.t("Invalid value"));
		}
		const fields = descriptor.itemFields ?? [];
		let existing: unknown[] = [];
		try {
			const root = JSON.parse(currentText) as Record<string, unknown>;
			let node: unknown = root;
			for (const key of descriptor.path) {
				node = (node as Record<string, unknown> | undefined)?.[key];
			}
			if (Array.isArray(node)) {
				existing = node;
			}
		} catch {
			// 既存値が読めない場合は引き継ぎなしで続行
		}

		return rawValue.map((row, index) => {
			if (row === null || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(vscode.l10n.t("Invalid value"));
			}
			const source = row as Record<string, unknown>;
			const base = existing[index];
			const result: Record<string, unknown> =
				base !== null && typeof base === "object" && !Array.isArray(base)
					? { ...(base as Record<string, unknown>) }
					: {};
			for (const field of fields) {
				const value = String(source[field.key] ?? "").trim();
				if (value.length === 0) {
					if (field.required) {
						throw new Error(vscode.l10n.t("Invalid value"));
					}
					delete result[field.key];
					continue;
				}
				if (field.pattern && !new RegExp(field.pattern).test(value)) {
					throw new Error(vscode.l10n.t("Invalid value"));
				}
				result[field.key] = value;
			}
			return result;
		});
	}

	/** 現在値を webview に再送する（自己書き込み後・外部編集検知時） */
	private postValues(): void {
		if (this.disposed) {
			return;
		}
		try {
			this.panel.webview.postMessage({
				type: "values",
				values: this.readValues(),
			});
		} catch (error) {
			Logger.getInstance().warn(
				"settings-ui",
				"Failed to post values to settings editor",
				formatError(error),
			);
		}
	}

	private buildHtml(): string {
		const webview = this.panel.webview;
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "assets", "settings-ui", "settings.css"),
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "assets", "settings-ui", "main.js"),
		);
		const nonce = generateNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>mdait Settings</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function generateNonce(): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let nonce = "";
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
