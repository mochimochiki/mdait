import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../config/configuration";
import type { AIMessage } from "./ai-service";

/**
 * AI通信統計レコードの型定義
 */
export interface AIStatsRecord {
	timestamp: string;
	provider: string;
	model: string;
	inputChars: number;
	outputChars: number;
	durationMs: number;
	status: "success" | "error";
	errorMessage?: string;
}

/**
 * AI通信詳細レコードの型定義
 */
export interface AIDetailedRecord {
	timestamp: string;
	provider: string;
	model: string;
	request: {
		systemPrompt: string;
		messages: AIMessage[];
	};
	response: {
		content: string;
		durationMs: number;
	};
	status: "success" | "error";
	errorMessage?: string;
}

/**
 * AI通信統計をログファイルに記録するクラス
 * デバッグ時の分析を容易にするため、1回のAI通信を1行のTSVレコードとして記録します。
 */
export class AIStatsLogger {
	private static instance: AIStatsLogger | undefined;
	private logFilePath: string | undefined;
	private detailedLogFilePath: string | undefined;

	private constructor() {}

	/**
	 * シングルトンインスタンスを取得
	 */
	public static getInstance(): AIStatsLogger {
		if (!AIStatsLogger.instance) {
			AIStatsLogger.instance = new AIStatsLogger();
		}
		return AIStatsLogger.instance;
	}

	/**
	 * 統計情報をログファイルに記録
	 * 設定で有効化されている場合のみ実行されます
	 *
	 * @param record 記録する統計情報
	 */
	public async log(record: AIStatsRecord): Promise<void> {
		try {
			// 設定確認
			const config = Configuration.getInstance();
			const enableLogging = config.ai.debug?.enableStatsLogging;

			if (!enableLogging) {
				return; // ログ機能が無効の場合は何もしない
			}

			// ログファイルパスの初期化
			if (!this.logFilePath) {
				await this.initializeLogFile();
			}

			if (!this.logFilePath) {
				console.warn("AI stats log file path is not initialized");
				return;
			}

			// TSV形式でレコードをフォーマット
			const tsvLine = this.formatAsTSV(record);

			// ファイルに非同期で追記（ベストエフォート）
			await fs.appendFile(this.logFilePath, `${tsvLine}\n`, "utf-8");
		} catch (error) {
			// ログ記録の失敗は本処理に影響させない
			console.warn("Failed to write AI stats log:", error);
		}
	}

	/**
	 * ログファイルとディレクトリを初期化
	 */
	private async initializeLogFile(): Promise<void> {
		try {
			// ワークスペースルートを取得
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) {
				console.warn("Workspace not found for AI stats logging");
				return;
			}

			// ログディレクトリのパス
			const logDir = path.join(workspaceRoot, ".mdait", "logs");
			this.logFilePath = path.join(logDir, "ai-stats.log");

			// ディレクトリが存在しない場合は作成
			await fs.mkdir(logDir, { recursive: true });

			// ファイルが存在しない場合はヘッダー行を書き込み
			try {
				await fs.access(this.logFilePath);
			} catch {
				// ファイルが存在しない場合
				const header = "timestamp\tprovider\tmodel\tinput_chars\toutput_chars\tduration_ms\tstatus\terror_message";
				await fs.writeFile(this.logFilePath, `${header}\n`, "utf-8");
			}
		} catch (error) {
			console.error("Failed to initialize AI stats log file:", error);
			this.logFilePath = undefined;
		}
	}

	/**
	 * レコードをTSV形式の文字列に変換
	 */
	private formatAsTSV(record: AIStatsRecord): string {
		const errorMsg = record.errorMessage ? record.errorMessage.replace(/[\t\n\r]/g, " ") : "";
		return [
			record.timestamp,
			record.provider,
			record.model,
			record.inputChars.toString(),
			record.outputChars.toString(),
			record.durationMs.toString(),
			record.status,
			errorMsg,
		].join("\t");
	}

	/**
	 * 詳細情報（プロンプトと応答）をログファイルに記録
	 * 設定で有効化されている場合のみ実行されます
	 *
	 * @param record 記録する詳細情報
	 */
	public async logDetailed(record: AIDetailedRecord): Promise<void> {
		try {
			// 設定確認
			const config = Configuration.getInstance();
			const enableLogging = config.ai.debug?.logPromptAndResponse;

			if (!enableLogging) {
				return; // ログ機能が無効の場合は何もしない
			}

			// ログファイルパスの初期化
			if (!this.detailedLogFilePath) {
				await this.initializeDetailedLogFile();
			}

			if (!this.detailedLogFilePath) {
				console.warn("AI detailed log file path is not initialized");
				return;
			}

			// JSON Lines形式でレコードをフォーマット
			const jsonLine = JSON.stringify(record);

			// ファイルに非同期で追記（ベストエフォート）
			await fs.appendFile(this.detailedLogFilePath, `${jsonLine}\n`, "utf-8");
		} catch (error) {
			// ログ記録の失敗は本処理に影響させない
			console.warn("Failed to write AI detailed log:", error);
		}
	}

	/**
	 * 詳細ログファイルとディレクトリを初期化
	 */
	private async initializeDetailedLogFile(): Promise<void> {
		try {
			// ワークスペースルートを取得
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) {
				console.warn("Workspace not found for AI detailed logging");
				return;
			}

			// ログディレクトリのパス
			const logDir = path.join(workspaceRoot, ".mdait", "logs");
			this.detailedLogFilePath = path.join(logDir, "ai-detailed.log");

			// ディレクトリが存在しない場合は作成
			await fs.mkdir(logDir, { recursive: true });

			// ファイルが存在しない場合でもヘッダーは不要（JSON Lines形式のため）
		} catch (error) {
			console.error("Failed to initialize AI detailed log file:", error);
			this.detailedLogFilePath = undefined;
		}
	}

	/**
	 * テスト用: インスタンスをリセット
	 */
	public static reset(): void {
		AIStatsLogger.instance = undefined;
	}
}
