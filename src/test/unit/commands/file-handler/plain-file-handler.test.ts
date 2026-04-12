import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { PlainFileHandler } from "../../../../commands/file-handler/plain-file-handler";
import type { Translator } from "../../../../commands/trans/translator";
import { FileStateStore } from "../../../../core/file-state/file-state-store";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { Status, StatusItemType } from "../../../../core/status/status-item";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** テスト用一時ディレクトリを作成 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-pfh-"));
}

/** テスト用一時ディレクトリを削除 */
function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** ディレクトリを再帰作成 */
function mkdirp(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

suite("PlainFileHandler", () => {
	let tempDir: string;
	let handler: PlainFileHandler;

	setup(() => {
		FileStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();

		tempDir = createTempDir();
		__vscodeMockWorkspaceRoot = tempDir;

		// FileStateStoreを空の状態でロード
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		handler = new PlainFileHandler();
	});

	teardown(() => {
		FileStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();
		cleanupTempDir(tempDir);
	});

	suite("sync()", () => {
		test("ソース未変更の場合、needが維持されunchanged=1となること", async () => {
			const sourceFile = path.join(tempDir, "source", "test.txt");
			const targetFile = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			const sourceContent = "hello content";
			fs.writeFileSync(sourceFile, sourceContent, "utf-8");
			fs.writeFileSync(targetFile, "translated content", "utf-8");

			const sourceHash = calculateHash(sourceContent, false);
			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: calculateHash("translated content", false),
				fromHash: sourceHash,
				need: "",
			});

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.unchanged, 1);
			assert.strictEqual(result.modified, 0);
			assert.strictEqual(result.revisionsNeeded, 0);

			const entry = store.getEntry("target/test.txt");
			assert.ok(entry);
			assert.strictEqual(entry.need, "");
		});

		test("ソース変更時、need:revise@旧ハッシュが付与されmodified=1となること", async () => {
			const sourceFile = path.join(tempDir, "source", "test.txt");
			const targetFile = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			const oldContent = "old content";
			const newContent = "new content";
			const oldHash = calculateHash(oldContent, false);

			// ソースファイルは更新後の内容
			fs.writeFileSync(sourceFile, newContent, "utf-8");
			fs.writeFileSync(targetFile, "translated content", "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: calculateHash("translated content", false),
				fromHash: oldHash,
				need: "",
			});

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.modified, 1);
			assert.strictEqual(result.revisionsNeeded, 1);
			assert.strictEqual(result.unchanged, 0);

			const entry = store.getEntry("target/test.txt");
			assert.ok(entry);
			assert.strictEqual(entry.need, `revise@${oldHash}`);
		});

		test("rebuild時（エントリなし）、need:reviewが付与されること", async () => {
			const sourceFile = path.join(tempDir, "source", "test.txt");
			const targetFile = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			fs.writeFileSync(sourceFile, "source text", "utf-8");
			fs.writeFileSync(targetFile, "existing translation", "utf-8");

			// FileStateStoreにエントリを登録しない（rebuild状態）

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.modified, 1);
			assert.strictEqual(result.revisionsNeeded, 1);

			const store = FileStateStore.getInstance();
			const entry = store.getEntry("target/test.txt");
			assert.ok(entry);
			assert.strictEqual(entry.need, "review");
			assert.strictEqual(entry.fromHash, calculateHash("source text", false));
		});

		test("ソース未変更でneed:translate保持中の場合、needが維持されること", async () => {
			const sourceFile = path.join(tempDir, "source", "data.csv");
			const targetFile = path.join(tempDir, "target", "data.csv");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			const content = "col1,col2\nval1,val2";
			fs.writeFileSync(sourceFile, content, "utf-8");
			fs.writeFileSync(targetFile, content, "utf-8");

			const hash = calculateHash(content, false);
			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/data.csv",
				hash,
				fromHash: hash,
				need: "translate",
			});

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.unchanged, 1);
			assert.strictEqual(result.modified, 0);

			const entry = store.getEntry("target/data.csv");
			assert.ok(entry);
			assert.strictEqual(entry.need, "translate");
		});
	});

	suite("syncNew()", () => {
		test("ターゲットファイルが作成されソース内容がコピーされること", async () => {
			const sourceFile = path.join(tempDir, "source", "new.txt");
			const targetFile = path.join(tempDir, "target", "new.txt");
			mkdirp(path.dirname(sourceFile));

			const content = "brand new content";
			fs.writeFileSync(sourceFile, content, "utf-8");

			const result = await handler.syncNew(sourceFile, targetFile);

			assert.strictEqual(result.added, 1);
			assert.strictEqual(result.modified, 0);
			assert.ok(fs.existsSync(targetFile));
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), content);
		});

		test("FileStateStoreにneed:translateでエントリが登録されること", async () => {
			const sourceFile = path.join(tempDir, "source", "new.txt");
			const targetFile = path.join(tempDir, "target", "new.txt");
			mkdirp(path.dirname(sourceFile));

			const content = "new file content";
			fs.writeFileSync(sourceFile, content, "utf-8");

			await handler.syncNew(sourceFile, targetFile);

			const store = FileStateStore.getInstance();
			const entry = store.getEntry("target/new.txt");
			assert.ok(entry);
			assert.strictEqual(entry.need, "translate");
			assert.strictEqual(entry.fromHash, calculateHash(content, false));
			assert.strictEqual(entry.hash, calculateHash(content, false));
		});
	});

	suite("collectStatus()", () => {
		test("エントリなしの場合、Status.Sourceが返されること", async () => {
			const filePath = path.join(tempDir, "source", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.Source);
			assert.strictEqual(status.contextValue, "mdaitFileSource");
			assert.strictEqual(status.translatedUnits, 0);
			assert.strictEqual(status.totalUnits, 1);
		});

		test("need空文字の場合、Status.Translatedが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "translated", "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.Translated);
			assert.strictEqual(status.contextValue, "mdaitFileTargetComplete");
			assert.strictEqual(status.translatedUnits, 1);
		});

		test("need:translateの場合、Status.NeedsTranslationが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "translate",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.NeedsTranslation);
			assert.strictEqual(status.contextValue, "mdaitFileTarget");
			assert.strictEqual(status.translatedUnits, 0);
		});

		test("need:revise@の場合、Status.NeedsTranslationが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "revise@cccc",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.NeedsTranslation);
		});

		test("need:reviewの場合、Status.NeedsTranslationが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "review",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.NeedsTranslation);
		});

		test("ファイルサイズがmaxFileSizeを超過する場合、tooltipが設定されること", async () => {
			const filePath = path.join(tempDir, "target", "large.txt");
			mkdirp(path.dirname(filePath));
			// maxFileSize のデフォルト 51200 より大きいコンテンツを作成
			const largeContent = "x".repeat(52000);
			fs.writeFileSync(filePath, largeContent, "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/large.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "",
			});

			const status = await handler.collectStatus(filePath);

			assert.ok(status.tooltip, "tooltipが設定されていること");
			assert.strictEqual(status.status, Status.Translated);
		});
	});

	suite("isInitialized()", () => {
		test("FileStateStoreにエントリがある場合、trueを返すこと", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "",
			});

			const result = await handler.isInitialized(filePath);
			assert.strictEqual(result, true);
		});

		test("FileStateStoreにエントリがない場合、falseを返すこと", async () => {
			const filePath = path.join(tempDir, "target", "unknown.txt");

			const result = await handler.isInitialized(filePath);
			assert.strictEqual(result, false);
		});
	});

	suite("translate() 早期リターン", () => {
		/** translate()の引数に使うダミーオブジェクト */
		const dummyTranslator = {} as Translator;
		const dummyProgress: vscode.Progress<{
			message?: string;
			increment?: number;
		}> = { report: () => {} };
		const dummyToken: vscode.CancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} }),
		};

		test("ファイルサイズがmaxFileSizeを超過する場合、skippedCount=1で返ること", async () => {
			const targetFile = path.join(tempDir, "target", "large.txt");
			mkdirp(path.dirname(targetFile));
			// デフォルトmaxFileSize(51200)より大きいファイルを作成
			fs.writeFileSync(targetFile, "x".repeat(52000), "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/large.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "translate",
			});

			const pair = {
				sourceDir: "source",
				targetDir: "target",
				sourceLang: "ja",
				targetLang: "en",
			};

			const result = await handler.translate(
				targetFile,
				dummyTranslator,
				pair,
				dummyProgress,
				dummyToken,
			);

			assert.ok(result);
			assert.strictEqual(result.skippedCount, 1);
			assert.strictEqual(result.translatedCount, 0);
		});

		test("FileStateStoreにエントリがない場合、undefinedを返すこと", async () => {
			const targetFile = path.join(tempDir, "target", "noentry.txt");
			mkdirp(path.dirname(targetFile));
			fs.writeFileSync(targetFile, "content", "utf-8");

			// FileStateStoreにエントリを登録しない

			const pair = {
				sourceDir: "source",
				targetDir: "target",
				sourceLang: "ja",
				targetLang: "en",
			};

			const result = await handler.translate(
				targetFile,
				dummyTranslator,
				pair,
				dummyProgress,
				dummyToken,
			);

			assert.strictEqual(result, undefined);
		});

		test("need空文字の場合、undefinedを返すこと（翻訳不要）", async () => {
			const targetFile = path.join(tempDir, "target", "done.txt");
			mkdirp(path.dirname(targetFile));
			fs.writeFileSync(targetFile, "translated content", "utf-8");

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/done.txt",
				hash: "aaaa",
				fromHash: "bbbb",
				need: "",
			});

			const pair = {
				sourceDir: "source",
				targetDir: "target",
				sourceLang: "ja",
				targetLang: "en",
			};

			const result = await handler.translate(
				targetFile,
				dummyTranslator,
				pair,
				dummyProgress,
				dummyToken,
			);

			assert.strictEqual(result, undefined);
		});
	});

	suite("translate() reviseパッチモード", () => {
		const dummyProgress: vscode.Progress<{
			message?: string;
			increment?: number;
		}> = { report: () => {} };
		const dummyToken: vscode.CancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} }),
		};

		/** reviseテスト用のソース・ターゲットファイルを準備 */
		function setupReviseFiles(opts: {
			oldSource: string;
			newSource: string;
			previousTranslation: string;
		}): {
			targetFile: string;
			pair: {
				sourceDir: string;
				targetDir: string;
				sourceLang: string;
				targetLang: string;
			};
		} {
			const sourceFile = path.join(tempDir, "source", "test.txt");
			const targetFile = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			fs.writeFileSync(sourceFile, opts.newSource, "utf-8");
			fs.writeFileSync(targetFile, opts.previousTranslation, "utf-8");

			const oldHash = calculateHash(opts.oldSource, false);

			// UnitRegistryに旧ソースを保存（loadUnitRegistryで取得できるようにする）
			const urm = UnitRegistryManager.getInstance();
			urm.saveUnitRegistry(oldHash, opts.oldSource);

			const store = FileStateStore.getInstance();
			store.setEntry({
				targetPath: "target/test.txt",
				hash: calculateHash(opts.previousTranslation, false),
				fromHash: oldHash,
				need: `revise@${oldHash}`,
			});

			return {
				targetFile,
				pair: {
					sourceDir: "source",
					targetDir: "target",
					sourceLang: "ja",
					targetLang: "en",
				},
			};
		}

		test("パッチ適用成功時、patchedCount=1で返ること", async () => {
			const { targetFile, pair } = setupReviseFiles({
				oldSource: "line1\nline2\nline3",
				newSource: "line1\nline2 changed\nline3",
				previousTranslation: "translated1\ntranslated2\ntranslated3",
			});

			const mockTranslator = {
				translateRevisionPatch: async () => ({
					targetPatch:
						"=translated1\n-translated2\n+translated2 updated\n=translated3",
					termSuggestions: [],
					warnings: [],
				}),
				translate: async () => {
					throw new Error("translate() should not be called in patch mode");
				},
			} as unknown as Translator;

			const result = await handler.translate(
				targetFile,
				mockTranslator,
				pair,
				dummyProgress,
				dummyToken,
			);

			assert.ok(result);
			assert.strictEqual(result.patchedCount, 1);
			assert.strictEqual(result.translatedCount, 0);
		});

		test("パッチ適用失敗時、全文翻訳にフォールバックしtranslatedCount=1で返ること", async () => {
			const { targetFile, pair } = setupReviseFiles({
				oldSource: "line1\nline2\nline3",
				newSource: "line1\nline2 changed\nline3",
				previousTranslation: "translated1\ntranslated2\ntranslated3",
			});

			const mockTranslator = {
				translateRevisionPatch: async () => ({
					// コンテキスト行が一致しない不正なパッチ → applySimplePatch が null を返す
					targetPatch:
						"=WRONG_CONTEXT\n-translated2\n+translated2 updated\n=WRONG",
					termSuggestions: [],
					warnings: [],
				}),
				translate: async () => ({
					translatedText: "full translation fallback",
					termSuggestions: [],
				}),
			} as unknown as Translator;

			const result = await handler.translate(
				targetFile,
				mockTranslator,
				pair,
				dummyProgress,
				dummyToken,
			);

			assert.ok(result);
			assert.strictEqual(result.translatedCount, 1);
			assert.strictEqual(result.patchedCount, 0);
		});

		test("パッチ翻訳で例外発生時、全文翻訳にフォールバックすること", async () => {
			const { targetFile, pair } = setupReviseFiles({
				oldSource: "line1\nline2\nline3",
				newSource: "line1\nline2 changed\nline3",
				previousTranslation: "translated1\ntranslated2\ntranslated3",
			});

			const mockTranslator = {
				translateRevisionPatch: async () => {
					throw new Error("LLM API error");
				},
				translate: async () => ({
					translatedText: "full translation after error",
					termSuggestions: [],
				}),
			} as unknown as Translator;

			const result = await handler.translate(
				targetFile,
				mockTranslator,
				pair,
				dummyProgress,
				dummyToken,
			);

			assert.ok(result);
			assert.strictEqual(result.translatedCount, 1);
			assert.strictEqual(result.patchedCount, 0);
		});
	});
});
