import type * as vscode from "vscode";

/**
 * ログレベル定義
 * 値が大きいほど重要度が高い
 */
export enum LogLevel {
	DEBUG = 10,
	INFO = 20,
	WARN = 30,
	ERROR = 40,
}

/**
 * ログレベル文字列からLogLevelに変換
 */
export function parseLogLevel(level: string): LogLevel {
	switch (level.toUpperCase()) {
		case "DEBUG":
			return LogLevel.DEBUG;
		case "INFO":
			return LogLevel.INFO;
		case "WARN":
			return LogLevel.WARN;
		case "ERROR":
			return LogLevel.ERROR;
		default:
			return LogLevel.INFO;
	}
}

/**
 * LogLevelから文字列表現を取得
 */
function levelToString(level: LogLevel): string {
	switch (level) {
		case LogLevel.DEBUG:
			return "DEBUG";
		case LogLevel.INFO:
			return "INFO";
		case LogLevel.WARN:
			return "WARN";
		case LogLevel.ERROR:
			return "ERROR";
		default:
			return "INFO";
	}
}

/**
 * Errorオブジェクトをシリアライズ可能な形式に変換
 * @param error エラーオブジェクト
 * @returns シリアライズ可能なオブジェクト
 */
export function formatError(error: unknown): object {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	if (typeof error === "object" && error !== null) {
		return error as object;
	}
	return { value: String(error) };
}

/**
 * 現在時刻をフォーマット
 * @returns YYYY-MM-DD HH:mm:ss 形式の文字列
 */
function formatTimestamp(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * mdait拡張機能用シングルトンLogger
 *
 * @example
 * ```typescript
 * const logger = Logger.getInstance();
 * logger.initialize(outputChannel);
 * logger.setLevel(LogLevel.DEBUG);
 *
 * logger.info("sync", "Sync started", { fileCount: 10 });
 * logger.error("trans", "Translation failed", formatError(error));
 * ```
 */
export class Logger {
	private static instance: Logger | undefined;
	private channel: vscode.OutputChannel | undefined;
	private level: LogLevel = LogLevel.INFO;

	private constructor() {}

	/**
	 * Loggerシングルトンインスタンスを取得
	 */
	static getInstance(): Logger {
		if (!Logger.instance) {
			Logger.instance = new Logger();
		}
		return Logger.instance;
	}

	/**
	 * OutputChannelを設定してLoggerを初期化
	 * @param channel VSCode OutputChannel
	 */
	initialize(channel: vscode.OutputChannel): void {
		this.channel = channel;
	}

	/**
	 * ログレベルを設定
	 * @param level 新しいログレベル
	 */
	setLevel(level: LogLevel): void {
		this.level = level;
	}

	/**
	 * 現在のログレベルを取得
	 */
	getLevel(): LogLevel {
		return this.level;
	}

	/**
	 * ログメッセージをフォーマット
	 * @param level ログレベル
	 * @param scope スコープ（コンポーネント名）
	 * @param message メッセージ
	 * @param context 追加コンテキスト（オプション）
	 * @returns フォーマット済みログ行
	 */
	private formatMessage(level: LogLevel, scope: string, message: string, context?: object): string {
		const timestamp = formatTimestamp();
		const levelStr = levelToString(level);
		let line = `[${timestamp}][${levelStr}][${scope}] ${message}`;
		if (context !== undefined) {
			line += ` | ${JSON.stringify(context)}`;
		}
		return line;
	}

	/**
	 * ログを出力
	 * @param level ログレベル
	 * @param scope スコープ
	 * @param message メッセージ
	 * @param context 追加コンテキスト
	 */
	private log(level: LogLevel, scope: string, message: string, context?: object): void {
		if (level < this.level) {
			return;
		}
		const line = this.formatMessage(level, scope, message, context);
		if (this.channel) {
			this.channel.appendLine(line);
		}
	}

	/**
	 * DEBUGレベルのログを出力
	 * @param scope スコープ
	 * @param message メッセージ
	 * @param context 追加コンテキスト
	 */
	debug(scope: string, message: string, context?: object): void {
		this.log(LogLevel.DEBUG, scope, message, context);
	}

	/**
	 * INFOレベルのログを出力
	 * @param scope スコープ
	 * @param message メッセージ
	 * @param context 追加コンテキスト
	 */
	info(scope: string, message: string, context?: object): void {
		this.log(LogLevel.INFO, scope, message, context);
	}

	/**
	 * WARNレベルのログを出力
	 * @param scope スコープ
	 * @param message メッセージ
	 * @param context 追加コンテキスト
	 */
	warn(scope: string, message: string, context?: object): void {
		this.log(LogLevel.WARN, scope, message, context);
	}

	/**
	 * ERRORレベルのログを出力
	 * @param scope スコープ
	 * @param message メッセージ
	 * @param context 追加コンテキスト
	 */
	error(scope: string, message: string, context?: object): void {
		this.log(LogLevel.ERROR, scope, message, context);
	}
}
