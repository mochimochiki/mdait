import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { PlainFileHandler } from "../../../../commands/file-handler/plain-file-handler";
import type { Translator } from "../../../../commands/trans/translator";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
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
		UnitStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();

		tempDir = createTempDir();
		__vscodeMockWorkspaceRoot = tempDir;

		// UnitStateStoreを空の状態でロード
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		handler = new PlainFileHandler();
	});

	teardown(() => {
		UnitStateStore.dispose();
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
			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: calculateHash("translated content", false),
				from: sourceHash,
				need: "",
			});

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.unchanged, 1);
			assert.strictEqual(result.modified, 0);
			assert.strictEqual(result.revisionsNeeded, 0);

			const entry = store.getEntry("target/test.txt", 0);
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

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: calculateHash("translated content", false),
				from: oldHash,
				need: "",
			});

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.modified, 1);
			assert.strictEqual(result.revisionsNeeded, 1);
			assert.strictEqual(result.unchanged, 0);

			const entry = store.getEntry("target/test.txt", 0);
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

			// UnitStateStoreにエントリを登録しない（rebuild状態）

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.modified, 1);
			assert.strictEqual(result.revisionsNeeded, 1);

			const store = UnitStateStore.getInstance();
			const entry = store.getEntry("target/test.txt", 0);
			assert.ok(entry);
			assert.strictEqual(entry.need, "review");
			assert.strictEqual(entry.from, calculateHash("source text", false));
		});

		test("複数回のソース更新で最初のrevise基準ハッシュが保持されること", async () => {
			const sourceFile = path.join(tempDir, "source", "test.txt");
			const targetFile = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			const originalContent = "original content";
			const secondContent = "second content";
			const thirdContent = "third content";
			const originalHash = calculateHash(originalContent, false);
			const secondHash = calculateHash(secondContent, false);

			fs.writeFileSync(targetFile, "translated content", "utf-8");

			// 初回: originalHash → secondContent でrevise@originalHash
			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: calculateHash("translated content", false),
				from: originalHash,
				need: "",
			});

			fs.writeFileSync(sourceFile, secondContent, "utf-8");
			await handler.sync(sourceFile, targetFile);

			const entryAfterFirst = store.getEntry("target/test.txt", 0);
			assert.ok(entryAfterFirst);
			assert.strictEqual(entryAfterFirst.need, `revise@${originalHash}`);

			// 2回目: secondHash → thirdContent だが、既にrevise@originalHash
			// fromHashはsecondHashに更新されるが、needの基準ハッシュはoriginalHashのまま
			fs.writeFileSync(sourceFile, thirdContent, "utf-8");
			await handler.sync(sourceFile, targetFile);

			const entryAfterSecond = store.getEntry("target/test.txt", 0);
			assert.ok(entryAfterSecond);
			assert.strictEqual(
				entryAfterSecond.need,
				`revise@${originalHash}`,
				"2回目のソース更新で基準ハッシュが上書きされてはならない",
			);
			assert.strictEqual(
				entryAfterSecond.from,
				calculateHash(thirdContent, false),
				"fromHashは最新のソースハッシュに更新される",
			);
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
			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/data.csv",
				order: 0,
				level: 0,
				titleHash: "",
				hash,
				from: hash,
				need: "translate",
			});

			const result = await handler.sync(sourceFile, targetFile);

			assert.strictEqual(result.unchanged, 1);
			assert.strictEqual(result.modified, 0);

			const entry = store.getEntry("target/data.csv", 0);
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

		test("UnitStateStoreにneed:translateでエントリが登録されること", async () => {
			const sourceFile = path.join(tempDir, "source", "new.txt");
			const targetFile = path.join(tempDir, "target", "new.txt");
			mkdirp(path.dirname(sourceFile));

			const content = "new file content";
			fs.writeFileSync(sourceFile, content, "utf-8");

			await handler.syncNew(sourceFile, targetFile);

			const store = UnitStateStore.getInstance();
			const entry = store.getEntry("target/new.txt", 0);
			assert.ok(entry);
			assert.strictEqual(entry.need, "translate");
			assert.strictEqual(entry.from, calculateHash(content, false));
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
			assert.strictEqual(status.contextValue, "mdaitPlainFileSource");
			assert.strictEqual(status.translatedUnits, 0);
			assert.strictEqual(status.totalUnits, 1);
			assert.strictEqual(status.needFlag, undefined, "未登録ファイルはファイルレベルneedを持たないこと");
		});

		test("need空文字の場合、Status.Translatedが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "translated", "utf-8");

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
				need: "",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.Translated);
			assert.strictEqual(status.contextValue, "mdaitPlainFileTargetComplete");
			assert.strictEqual(status.translatedUnits, 1);
			assert.strictEqual(status.needFlag, undefined, "翻訳済みはファイルレベルneedを持たないこと");
		});

		test("need:translateの場合、Status.NeedsTranslationが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
				need: "translate",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.NeedsTranslation);
			assert.strictEqual(status.contextValue, "mdaitPlainFileTarget");
			assert.strictEqual(status.translatedUnits, 0);
			// 非MDは children を持たないため、翻訳待ちはファイルレベルの needFlag に載る
			// （sync完了通知の翻訳待ち件数がプレーンファイルを拾えるようにする）
			assert.strictEqual(status.needFlag, "translate");
		});

		test("need:revise@の場合、Status.NeedsTranslationが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
				need: "revise@cccc",
			});

			const status = await handler.collectStatus(filePath);

			assert.strictEqual(status.status, Status.NeedsTranslation);
			assert.strictEqual(status.needFlag, "revise@cccc", "revise@の値がそのままファイルレベルneedに載ること");
		});

		test("need:reviewの場合、Status.NeedsTranslationが返されること", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");
			mkdirp(path.dirname(filePath));
			fs.writeFileSync(filePath, "content", "utf-8");

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
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

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/large.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
				need: "",
			});

			const status = await handler.collectStatus(filePath);

			assert.ok(status.tooltip, "tooltipが設定されていること");
			assert.strictEqual(status.status, Status.Translated);
		});
	});

	suite("isInitialized()", () => {
		test("UnitStateStoreにエントリがある場合、trueを返すこと", async () => {
			const filePath = path.join(tempDir, "target", "test.txt");

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
				need: "",
			});

			const result = await handler.isInitialized(filePath);
			assert.strictEqual(result, true);
		});

		test("UnitStateStoreにエントリがない場合、falseを返すこと", async () => {
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

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/large.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
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

		test("UnitStateStoreにエントリがない場合、undefinedを返すこと", async () => {
			const targetFile = path.join(tempDir, "target", "noentry.txt");
			mkdirp(path.dirname(targetFile));
			fs.writeFileSync(targetFile, "content", "utf-8");

			// UnitStateStoreにエントリを登録しない

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

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/done.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: "aaaa",
				from: "bbbb",
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

		test("翻訳前にキャンセルされた場合、skipped=1が返ること", async () => {
			const sourceFile = path.join(tempDir, "source", "cancel.txt");
			const targetFile = path.join(tempDir, "target", "cancel.txt");
			mkdirp(path.dirname(sourceFile));
			mkdirp(path.dirname(targetFile));

			const content = "source content";
			fs.writeFileSync(sourceFile, content, "utf-8");
			fs.writeFileSync(targetFile, content, "utf-8");

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/cancel.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: calculateHash(content, false),
				from: calculateHash(content, false),
				need: "translate",
			});

			const pair = {
				sourceDir: "source",
				targetDir: "target",
				sourceLang: "ja",
				targetLang: "en",
			};

			const cancelledToken: vscode.CancellationToken = {
				isCancellationRequested: true,
				onCancellationRequested: () => ({ dispose: () => {} }),
			};

			const result = await handler.translate(
				targetFile,
				dummyTranslator,
				pair,
				dummyProgress,
				cancelledToken,
			);

			assert.ok(result);
			assert.strictEqual(result.skippedCount, 1);
			assert.strictEqual(result.translatedCount, 0);
			assert.strictEqual(result.patchedCount, 0);
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

			const store = UnitStateStore.getInstance();
			store.setEntry({
				path: "target/test.txt",
				order: 0,
				level: 0,
				titleHash: "",
				hash: calculateHash(opts.previousTranslation, false),
				from: oldHash,
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
