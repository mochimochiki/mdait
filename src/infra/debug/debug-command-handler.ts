import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Logger } from "../logging/logger";
import type { StructuredLogEntry } from "../logging/logger";

const DEBUG_DIR = ".mdait/debug";
const COMMAND_FILE = "command.json";
const RESULT_FILE = "result.json";
const READY_FILE = "ready";
const COMMAND_PREFIX = "mdait.";

const PARSE_RETRY_DELAY_MS = 100;
const PARSE_MAX_RETRIES = 3;

interface CommandPayload {
	id: string;
	command: string;
	args?: unknown[];
}

interface ResultPayload {
	id: string | null;
	command: string | null;
	status: "running" | "done" | "done-with-errors" | "error";
	result: unknown | null;
	error: string | null;
	logs: string[];
	structuredLogs: StructuredLogEntry[];
	startedAt: string | null;
	completedAt: string | null;
}

type ArgTransformer = (args: unknown[]) => unknown[];

const URI_FILE_COMMANDS = new Set([
	"mdait.trans",
	"mdait.translate.frontmatter",
]);
const FILE_ITEM_COMMANDS = new Set([
	"mdait.translate.file",
	"mdait.tm.commit.file",
	"mdait.term.detect.file",
	"mdait.term.expand.file",
]);
const DIRECTORY_ITEM_COMMANDS = new Set([
	"mdait.translate.directory",
	"mdait.term.detect.directory",
	"mdait.term.expand.directory",
]);
const TM_DIRECTORY_COMMANDS = new Set(["mdait.tm.commit.directory"]);

function buildArgTransformer(command: string): ArgTransformer | undefined {
	if (URI_FILE_COMMANDS.has(command)) {
		return (args) => {
			if (args.length > 0 && typeof args[0] === "string") {
				return [vscode.Uri.file(args[0]), ...args.slice(1)];
			}
			return args;
		};
	}
	// translateFile/translateDirectory expect StatusItem with type field
	if (FILE_ITEM_COMMANDS.has(command)) {
		return (args) => {
			if (args.length > 0 && typeof args[0] === "string") {
				return [
					{
						type: "file",
						filePath: args[0],
						fileName: args[0].split(/[\\/]/).pop() ?? "",
					},
					...args.slice(1),
				];
			}
			return args;
		};
	}
	if (DIRECTORY_ITEM_COMMANDS.has(command)) {
		return (args) => {
			if (args.length > 0 && typeof args[0] === "string") {
				return [
					{
						type: "directory",
						directoryPath: args[0],
						label: args[0].split(/[\\/]/).pop() ?? "",
					},
					...args.slice(1),
				];
			}
			return args;
		};
	}
	// tmCommitDirectoryCommand uses "dirPath" in item check
	if (TM_DIRECTORY_COMMANDS.has(command)) {
		return (args) => {
			if (args.length > 0 && typeof args[0] === "string") {
				return [
					{
						type: "directory",
						dirPath: args[0],
						directoryPath: args[0],
						label: args[0].split(/[\\/]/).pop() ?? "",
					},
					...args.slice(1),
				];
			}
			return args;
		};
	}
	return undefined;
}

export class DebugCommandHandler implements vscode.Disposable {
	private readonly debugDirPath: string;
	private readonly commandFilePath: string;
	private readonly resultFilePath: string;
	private readonly readyFilePath: string;
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly logger = Logger.getInstance();
	private isProcessing = false;

	constructor(workspaceRoot: string) {
		this.debugDirPath = path.join(workspaceRoot, DEBUG_DIR);
		this.commandFilePath = path.join(this.debugDirPath, COMMAND_FILE);
		this.resultFilePath = path.join(this.debugDirPath, RESULT_FILE);
		this.readyFilePath = path.join(this.debugDirPath, READY_FILE);

		this.ensureDebugDirectory();

		const pattern = new vscode.RelativePattern(
			workspaceRoot,
			`${DEBUG_DIR}/${COMMAND_FILE}`,
		);
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
		this.watcher.onDidCreate(() => this.onCommandFileDetected());
		this.watcher.onDidChange(() => this.onCommandFileDetected());

		this.logger.info("debug", "DebugCommandHandler initialized", {
			debugDir: this.debugDirPath,
		});
		fs.writeFileSync(this.readyFilePath, new Date().toISOString(), "utf-8");
	}

	dispose(): void {
		try {
			fs.unlinkSync(this.readyFilePath);
		} catch {}
		this.watcher.dispose();
	}

	private ensureDebugDirectory(): void {
		fs.mkdirSync(this.debugDirPath, { recursive: true });
		const gitignorePath = path.join(this.debugDirPath, ".gitignore");
		fs.writeFileSync(gitignorePath, "*\n", "utf-8");
	}

	private async onCommandFileDetected(): Promise<void> {
		if (this.isProcessing) {
			this.logger.debug("debug", "Command ignored: already processing");
			return;
		}
		this.isProcessing = true;
		try {
			await this.processCommand();
		} finally {
			this.isProcessing = false;
		}
	}

	private async processCommand(): Promise<void> {
		const payload = await this.readCommandWithRetry();
		if (!payload) {
			await this.writeResult({
				id: null,
				command: null,
				status: "error",
				result: null,
				error: "Invalid command.json",
				logs: [],
				structuredLogs: [],
				startedAt: null,
				completedAt: null,
			});
			this.deleteCommandFile();
			return;
		}

		if (!payload.command.startsWith(COMMAND_PREFIX)) {
			await this.writeResult({
				id: payload.id,
				command: payload.command,
				status: "error",
				result: null,
				error: `Command not allowed: ${payload.command}`,
				logs: [],
				structuredLogs: [],
				startedAt: null,
				completedAt: null,
			});
			this.deleteCommandFile();
			return;
		}

		const startedAt = new Date().toISOString();
		await this.writeResult({
			id: payload.id,
			command: payload.command,
			status: "running",
			result: null,
			error: null,
			logs: [],
			structuredLogs: [],
			startedAt,
			completedAt: null,
		});

		const capturedLogs: string[] = [];
		const capturedStructuredLogs: StructuredLogEntry[] = [];
		const logDisposable = this.logger.addLogListener((line, entry) => {
			capturedLogs.push(line);
			capturedStructuredLogs.push(entry);
		});

		try {
			let args = payload.args ?? [];
			const transformer = buildArgTransformer(payload.command);
			if (transformer) {
				args = transformer(args);
			}

			const result = await vscode.commands.executeCommand(
				payload.command,
				...args,
			);
			const completedAt = new Date().toISOString();

			const hasErrors =
				result != null &&
				typeof result === "object" &&
				"errorCount" in (result as object) &&
				((result as Record<string, unknown>).errorCount as number) > 0;
			const status = hasErrors ? "done-with-errors" : "done";

			await this.writeResult({
				id: payload.id,
				command: payload.command,
				status,
				result: result ?? null,
				error: null,
				logs: capturedLogs,
				structuredLogs: capturedStructuredLogs,
				startedAt,
				completedAt,
			});
		} catch (error) {
			const completedAt = new Date().toISOString();
			await this.writeResult({
				id: payload.id,
				command: payload.command,
				status: "error",
				result: null,
				error: error instanceof Error ? error.message : String(error),
				logs: capturedLogs,
				structuredLogs: capturedStructuredLogs,
				startedAt,
				completedAt,
			});
		} finally {
			logDisposable.dispose();
		}

		this.deleteCommandFile();
	}

	private async readCommandWithRetry(): Promise<CommandPayload | null> {
		for (let attempt = 0; attempt < PARSE_MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				await this.delay(PARSE_RETRY_DELAY_MS);
			}
			try {
				if (!fs.existsSync(this.commandFilePath)) {
					return null;
				}
				const raw = fs.readFileSync(this.commandFilePath, "utf-8");
				const parsed = JSON.parse(raw);
				if (this.isValidPayload(parsed)) {
					return parsed;
				}
				this.logger.warn("debug", "Invalid command payload structure", {
					attempt,
				});
			} catch {
				this.logger.debug("debug", "Parse attempt failed", { attempt });
			}
		}
		this.logger.error("debug", "Failed to parse command.json after retries");
		return null;
	}

	private isValidPayload(value: unknown): value is CommandPayload {
		if (typeof value !== "object" || value === null) {
			return false;
		}
		const obj = value as Record<string, unknown>;
		return typeof obj.id === "string" && typeof obj.command === "string";
	}

	private async writeResult(result: ResultPayload): Promise<void> {
		try {
			fs.writeFileSync(
				this.resultFilePath,
				JSON.stringify(result, null, 2),
				"utf-8",
			);
		} catch (error) {
			this.logger.error("debug", "Failed to write result.json", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private deleteCommandFile(): void {
		try {
			if (fs.existsSync(this.commandFilePath)) {
				fs.unlinkSync(this.commandFilePath);
			}
		} catch (error) {
			this.logger.warn("debug", "Failed to delete command.json", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
