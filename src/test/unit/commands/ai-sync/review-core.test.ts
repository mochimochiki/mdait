import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PairVerifier } from "../../../../commands/ai-sync/pair-verifier";
import { executeAiReviewForFile } from "../../../../commands/ai-sync/review-core";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { Configuration } from "../../../../infra/config/configuration";
import { PromptProvider } from "../../../../prompts";

declare let __vscodeMockWorkspaceRoot: string;

/** 応答列を順番に返すスタブAIService（応答後フックでキャンセル等を注入できる） */
class StubAIService implements AIService {
	public callCount = 0;
	private readonly responses: string[];
	public afterResponse?: () => void;
	/** 受け取った全 user メッセージ本文（note 注入の検証用） */
	public userMessages: string[] = [];

	constructor(responses: string[]) {
		this.responses = responses;
	}

	async sendMessage(
		_systemPrompt: string,
		_messages: AIMessage[],
		_cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		this.userMessages.push(String(_messages[_messages.length - 1]?.content ?? ""));
		const index = Math.min(this.callCount, this.responses.length - 1);
		this.callCount++;
		const response = this.responses[index];
		this.afterResponse?.();
		if (response === "__THROW__") {
			throw new Error("AI provider error");
		}
		return response;
	}
}

const MATCH = '{"verdict": "match", "confidence": 0.95, "issues": [], "reason": "Complete."}';
const MISMATCH = '{"verdict": "mismatch", "confidence": 0.9, "issues": [], "reason": "Different topics."}';
const PARTIAL = '{"verdict": "partial", "confidence": 0.8, "issues": ["omission"], "reason": "Incomplete."}';
const UNCERTAIN = '{"verdict": "uncertain", "confidence": 0.3, "issues": [], "reason": "Not sure."}';
const LOW_CONFIDENCE_MATCH = '{"verdict": "match", "confidence": 0.5, "issues": [], "reason": "Probably fine."}';

/** 両ユニットが確定済み（from あり・need なし）のターゲット */
const SETTLED_TARGET_CONTENT = `<!-- mdait tgtA from:srcA -->
## Section A

Content A.

<!-- mdait tgtB from:srcB -->
## Section B

Content B.
`;

const SOURCE_CONTENT = `<!-- mdait srcA -->
## セクションA

本文A。

<!-- mdait srcB -->
## セクションB

本文B。
`;

const TARGET_CONTENT = `<!-- mdait tgtA from:srcA need:review -->
## Section A

Content A.

<!-- mdait tgtB from:srcB need:review -->
## Section B

Content B.
`;

suite("executeAiReviewForFile（AIペアリング検証コア）", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	function writeConfig(aiSyncReview: Record<string, unknown> = {}): void {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				ai: { provider: "default" },
				// 本スイートは単ペア検証（従来挙動）の回帰テストのため batchSize: 1 を既定にする。
				// バッチ検証は後続の「バッチ検証」スイートで扱う。
				aiSync: { review: { batchSize: 1, ...aiSyncReview } },
			}),
			"utf-8",
		);
	}

	async function initConfig(aiSyncReview: Record<string, unknown> = {}): Promise<Configuration> {
		writeConfig(aiSyncReview);
		return await Configuration.getInstance().initialize(path.join(tempDir, ".mdait", "mdait.json"));
	}

	function writePair(sourceContent = SOURCE_CONTENT, targetContent = TARGET_CONTENT): void {
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(sourceFile, sourceContent, "utf-8");
		fs.writeFileSync(targetFile, targetContent, "utf-8");
	}

	function buildVerifier(stub: StubAIService): PairVerifier {
		const promptProvider = PromptProvider.getInstance();
		return new PairVerifier(stub, (id, variables) => promptProvider.getPromptParts(id, variables));
	}

	setup(() => {
		Configuration.dispose();
		PromptProvider.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-ai-review-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		PromptProvider.dispose();
		UnitRegistryManager.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("承認されたユニットの need:review だけが除去され hash / from / 本文は不変", async () => {
		const config = await initConfig();
		writePair();
		const verifier = buildVerifier(new StubAIService([MATCH, MISMATCH]));

		const result = await executeAiReviewForFile(targetFile, config, verifier);

		assert.strictEqual(result.verified, 2);
		assert.strictEqual(result.approved, 1);
		assert.strictEqual(result.escalated, 1);
		assert.strictEqual(result.markersChanged, true);

		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"));
		assert.ok(written.includes("<!-- mdait tgtB from:srcB need:review -->"));
		assert.ok(written.includes("Content A."));
		assert.ok(written.includes("Content B."));
	});

	test("2回目の実行では検証対象が無く無変更（冪等性）", async () => {
		const config = await initConfig();
		writePair();
		const first = await executeAiReviewForFile(targetFile, config, buildVerifier(new StubAIService([MATCH])));
		assert.strictEqual(first.approved, 2);

		const contentAfterFirst = fs.readFileSync(targetFile, "utf-8");
		const secondStub = new StubAIService([MATCH]);
		const second = await executeAiReviewForFile(targetFile, config, buildVerifier(secondStub));

		assert.strictEqual(second.verified, 0);
		assert.strictEqual(second.markersChanged, false);
		assert.strictEqual(secondStub.callCount, 0);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), contentAfterFirst);
	});

	test("dryRun ではマーカーが書き換わらない", async () => {
		const config = await initConfig();
		writePair();
		const result = await executeAiReviewForFile(targetFile, config, buildVerifier(new StubAIService([MATCH])), {
			dryRun: true,
		});

		assert.strictEqual(result.verified, 2);
		assert.strictEqual(result.approved, 0);
		assert.strictEqual(result.kept, 2);
		assert.strictEqual(result.markersChanged, false);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), TARGET_CONTENT);
	});

	test("autoApprove 無効時は match でも need:review が維持される", async () => {
		const config = await initConfig({ autoApprove: false });
		writePair();
		const result = await executeAiReviewForFile(targetFile, config, buildVerifier(new StubAIService([MATCH])));

		assert.strictEqual(result.approved, 0);
		assert.strictEqual(result.kept, 2);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), TARGET_CONTENT);
	});

	test("閾値未満の confidence は承認されない", async () => {
		const config = await initConfig({ autoApproveThreshold: 0.9 });
		writePair();
		const result = await executeAiReviewForFile(
			targetFile,
			config,
			buildVerifier(new StubAIService([LOW_CONFIDENCE_MATCH])),
		);

		assert.strictEqual(result.approved, 0);
		assert.strictEqual(result.kept, 2);
	});

	test("途中キャンセル時は完了分の承認のみ書き込まれる", async () => {
		const config = await initConfig();
		writePair();
		const cts = new vscode.CancellationTokenSource();
		const stub = new StubAIService([MATCH]);
		// 1ユニット目の応答後にキャンセル → 2ユニット目はループ先頭で中断
		stub.afterResponse = () => cts.cancel();

		const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub), {}, undefined, cts.token);

		assert.strictEqual(result.verified, 1);
		assert.strictEqual(result.approved, 1);
		assert.strictEqual(result.markersChanged, true);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"));
		assert.ok(written.includes("<!-- mdait tgtB from:srcB need:review -->"));
	});

	test("maxUnitsPerRun を超えるユニットは処理されない", async () => {
		const config = await initConfig({ maxUnitsPerRun: 1 });
		writePair();
		const stub = new StubAIService([MATCH]);
		const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

		assert.strictEqual(result.verified, 1);
		assert.strictEqual(result.approved, 1);
		assert.strictEqual(stub.callCount, 1);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtB from:srcB need:review -->"));
	});

	test("1ユニットのAI例外はファイル全体を止めない", async () => {
		const config = await initConfig();
		writePair();
		const result = await executeAiReviewForFile(
			targetFile,
			config,
			buildVerifier(new StubAIService(["__THROW__", MATCH])),
		);

		// リトライも失敗（同じ例外を返し続けるスタブではないため注意）:
		// 1ユニット目は例外→error、2ユニット目は match→approved
		assert.strictEqual(result.errors + result.approved, 2);
		assert.ok(result.approved >= 1);
	});

	test("from に対応するソースが無いユニットは skipped で need:review が維持される", async () => {
		const config = await initConfig();
		const targetWithOrphan = `<!-- mdait tgtA from:goneSource need:review -->
## Section A

Content A.
`;
		writePair(SOURCE_CONTENT, targetWithOrphan);
		const stub = new StubAIService([MATCH]);
		const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

		assert.strictEqual(result.skipped, 1);
		assert.strictEqual(result.verified, 0);
		assert.strictEqual(stub.callCount, 0);
		assert.ok(fs.readFileSync(targetFile, "utf-8").includes("need:review"));
	});

	suite("audit モード（対象拡張・確定済みペアの監査）", () => {
		test("pending では確定済みペアは列挙されず無変更", async () => {
			const config = await initConfig();
			writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
			const stub = new StubAIService([MATCH]);
			const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub), { mode: "pending" });

			assert.strictEqual(result.verified, 0);
			assert.strictEqual(stub.callCount, 0);
			assert.strictEqual(result.markersChanged, false);
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), SETTLED_TARGET_CONTENT);
		});

		test("audit で確定済みペアのドリフト（partial/mismatch）は報告のみ・マーカー不変", async () => {
			const config = await initConfig();
			writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
			// tgtA=partial（ドリフト）, tgtB=match（健全）
			const result = await executeAiReviewForFile(
				targetFile,
				config,
				buildVerifier(new StubAIService([PARTIAL, MATCH])),
				{ mode: "audit" },
			);

			assert.strictEqual(result.verified, 2);
			assert.strictEqual(result.flagged, 1);
			assert.strictEqual(result.audited, 1);
			assert.strictEqual(result.approved, 0);
			// 確定済みペアはドリフト検出しても一切マーカーを変えない（報告のみ）
			assert.strictEqual(result.markersChanged, false);
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), SETTLED_TARGET_CONTENT, "need:review は付与されない");
		});

		test("audit で全ペアが健全（match/uncertain）なら無変更（audited のみ）", async () => {
			const config = await initConfig();
			writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
			const result = await executeAiReviewForFile(
				targetFile,
				config,
				buildVerifier(new StubAIService([MATCH, UNCERTAIN])),
				{ mode: "audit" },
			);

			assert.strictEqual(result.audited, 2);
			assert.strictEqual(result.flagged, 0);
			assert.strictEqual(result.markersChanged, false);
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), SETTLED_TARGET_CONTENT);
		});

		test("audit は報告のみなので dryRun でもマーカー不変（挙動は同じ）", async () => {
			const config = await initConfig();
			writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
			const result = await executeAiReviewForFile(
				targetFile,
				config,
				buildVerifier(new StubAIService([MISMATCH, PARTIAL])),
				{ mode: "audit", dryRun: true },
			);

			assert.strictEqual(result.flagged, 2);
			assert.strictEqual(result.markersChanged, false);
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), SETTLED_TARGET_CONTENT);
		});

		test("audit は再実行しても確定済みペアを書き換えず、毎回同じ flagged を報告（マーカー安定）", async () => {
			const config = await initConfig();
			writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
			// 1回目: tgtA ドリフト→flagged（報告のみ）, tgtB 健全→audited
			const first = await executeAiReviewForFile(
				targetFile,
				config,
				buildVerifier(new StubAIService([MISMATCH, MATCH])),
				{ mode: "audit" },
			);
			assert.strictEqual(first.flagged, 1);
			assert.strictEqual(first.audited, 1);
			assert.strictEqual(first.markersChanged, false);
			// マーカーは一切変わらない（need:review は付与されない）
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), SETTLED_TARGET_CONTENT);

			// 2回目 audit: マーカーが変わっていないので同じ結果を再報告する（蒸し返しの churn は無し）
			const second = await executeAiReviewForFile(
				targetFile,
				config,
				buildVerifier(new StubAIService([MISMATCH, MATCH])),
				{ mode: "audit" },
			);
			assert.strictEqual(second.flagged, 1);
			assert.strictEqual(second.audited, 1);
			assert.strictEqual(second.markersChanged, false);
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), SETTLED_TARGET_CONTENT);
		});

		suite("ユニット note を AI へ渡す（意図的乖離の説明）", () => {
			test("registry の note が verify の user メッセージに <humanNote> として渡る", async () => {
				const config = await initConfig();
				writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
				// tgtA に note を保存（audit 対象の確定済みペア）
				await UnitRegistryManager.getInstance().saveNote("tgtA", "Section A is intentionally condensed.");

				const stub = new StubAIService([MATCH, MATCH]);
				await executeAiReviewForFile(targetFile, config, buildVerifier(stub), { mode: "audit" });

				// tgtA の検証メッセージに note が <humanNote> として含まれる
				assert.ok(
					stub.userMessages.some((m) => m.includes("<humanNote>") && m.includes("intentionally condensed")),
				);
			});

			test("note が無いユニットには <humanNote> を付けない", async () => {
				const config = await initConfig();
				writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
				const stub = new StubAIService([MATCH, MATCH]);
				await executeAiReviewForFile(targetFile, config, buildVerifier(stub), { mode: "audit" });
				assert.ok(stub.userMessages.every((m) => !m.includes("<humanNote>")));
			});
		});
	});

	suite("バッチ検証（batchSize >= 2）", () => {
		/** バッチ応答 {"results":[...]} を組み立てる */
		function batchResponse(
			...entries: Array<{ index: number; verdict: string; confidence?: number; issues?: string[] }>
		): string {
			return JSON.stringify({
				results: entries.map((e) => ({
					index: e.index,
					verdict: e.verdict,
					confidence: e.confidence ?? 0.95,
					issues: e.issues ?? [],
					reason: "batch",
				})),
			});
		}

		const SOURCE_CONTENT_4 = `<!-- mdait srcA -->
## セクションA

本文A。

<!-- mdait srcB -->
## セクションB

本文B。

<!-- mdait srcC -->
## セクションC

本文C。

<!-- mdait srcD -->
## セクションD

本文D。
`;

		const TARGET_CONTENT_4 = `<!-- mdait tgtA from:srcA need:review -->
## Section A

Content A.

<!-- mdait tgtB from:srcB need:review -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:review -->
## Section C

Content C.

<!-- mdait tgtD from:srcD need:review -->
## Section D

Content D.
`;

		test("デフォルト batchSize=3 で2ユニットが1回のLLMコールにまとまり index で対応付く", async () => {
			// batchSize 未指定 → デフォルト 3
			const config = await initConfig({ batchSize: undefined });
			writePair();
			const stub = new StubAIService([
				batchResponse({ index: 1, verdict: "match" }, { index: 2, verdict: "mismatch", confidence: 0.9 }),
			]);
			const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			assert.strictEqual(stub.callCount, 1, "2ユニットが1コールにまとまること");
			assert.strictEqual(result.verified, 2);
			assert.strictEqual(result.approved, 1);
			assert.strictEqual(result.escalated, 1);
			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"), "index 1 = tgtA が承認されること");
			assert.ok(written.includes("<!-- mdait tgtB from:srcB need:review -->"), "index 2 = tgtB は維持されること");
		});

		test("user message に <pair index> ブロックで両ユニット本文が含まれる", async () => {
			const config = await initConfig({ batchSize: 3 });
			writePair();
			const stub = new StubAIService([
				batchResponse({ index: 1, verdict: "match" }, { index: 2, verdict: "match" }),
			]);
			await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			const user = stub.userMessages[0];
			assert.ok(user.includes('<pair index="1">'));
			assert.ok(user.includes('<pair index="2">'));
			assert.ok(user.includes("本文A。"));
			assert.ok(user.includes("本文B。"));
		});

		test("batchSize=2 で4ユニットが2バッチに分かれ、1バッチ目後のキャンセルで完了分のみ反映", async () => {
			const config = await initConfig({ batchSize: 2 });
			writePair(SOURCE_CONTENT_4, TARGET_CONTENT_4);
			const cts = new vscode.CancellationTokenSource();
			const stub = new StubAIService([
				batchResponse({ index: 1, verdict: "match" }, { index: 2, verdict: "match" }),
			]);
			stub.afterResponse = () => cts.cancel();

			const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub), {}, undefined, cts.token);

			assert.strictEqual(stub.callCount, 1);
			assert.strictEqual(result.verified, 2);
			assert.strictEqual(result.approved, 2);
			assert.strictEqual(result.markersChanged, true);
			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"));
			assert.ok(written.includes("<!-- mdait tgtB from:srcB -->"));
			assert.ok(written.includes("<!-- mdait tgtC from:srcC need:review -->"), "未処理バッチは維持されること");
			assert.ok(written.includes("<!-- mdait tgtD from:srcD need:review -->"), "未処理バッチは維持されること");
		});

		test("バッチ呼び出しの例外はバッチ内全ユニットを error にして後続バッチを続行する", async () => {
			const config = await initConfig({ batchSize: 2 });
			writePair(SOURCE_CONTENT_4, TARGET_CONTENT_4);
			const stub = new StubAIService([
				"__THROW__",
				batchResponse({ index: 1, verdict: "match" }, { index: 2, verdict: "match" }),
			]);
			const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			assert.strictEqual(result.errors, 2, "1バッチ目の2ユニットが error になること");
			assert.strictEqual(result.approved, 2, "2バッチ目は処理されること");
			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(written.includes("<!-- mdait tgtA from:srcA need:review -->"), "error ユニットは維持されること");
			assert.ok(written.includes("<!-- mdait tgtC from:srcC -->"));
		});

		test("用語集にヒットしたエントリが <terms> としてペア内に注入される（原文側ヒット）", async () => {
			writeConfig({ batchSize: 3 });
			// 原文の「本文A」を含む用語エントリ（en 訳語つき）
			fs.writeFileSync(
				path.join(tempDir, ".mdait", "terms.csv"),
				"context,ja,en\ntest term,本文A,Body A\n",
				"utf-8",
			);
			const config = await Configuration.getInstance().initialize(path.join(tempDir, ".mdait", "mdait.json"));
			writePair();
			const stub = new StubAIService([
				batchResponse({ index: 1, verdict: "match" }, { index: 2, verdict: "match" }),
			]);
			await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			const user = stub.userMessages[0];
			assert.ok(user.includes("<terms>"), "terms ブロックが注入されること");
			assert.ok(user.includes("Body A"), "訳語が含まれること");
			// ヒットしないペア（Section B）の <pair> には terms が付かない
			const pair2 = user.slice(user.indexOf('<pair index="2">'));
			assert.ok(!pair2.includes("<terms>"), "ヒットしないペアには terms が付かないこと");
		});

		test("batchSize=1 の単ペア経路でも用語集が <terms> として注入される", async () => {
			writeConfig({ batchSize: 1 });
			fs.writeFileSync(
				path.join(tempDir, ".mdait", "terms.csv"),
				"context,ja,en\ntest term,本文A,Body A\n",
				"utf-8",
			);
			const config = await Configuration.getInstance().initialize(path.join(tempDir, ".mdait", "mdait.json"));
			writePair();
			const stub = new StubAIService([MATCH, MATCH]);
			await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			assert.strictEqual(stub.callCount, 2, "単ペア経路は1ユニット1コール");
			assert.ok(stub.userMessages[0].includes("<terms>"), "ヒットしたユニットに terms が注入されること");
			assert.ok(stub.userMessages[0].includes("Body A"));
			assert.ok(!stub.userMessages[1].includes("<terms>"), "ヒットしないユニットには注入されないこと");
		});

		test("訳文側だけにヒットした用語も注入される（訳揺れ検知の材料）", async () => {
			writeConfig({ batchSize: 3 });
			// 原文には現れず、訳文 "Content A." にだけヒットするエントリ
			fs.writeFileSync(
				path.join(tempDir, ".mdait", "terms.csv"),
				"context,ja,en\ntarget only,存在しない用語,Content A\n",
				"utf-8",
			);
			const config = await Configuration.getInstance().initialize(path.join(tempDir, ".mdait", "mdait.json"));
			writePair();
			const stub = new StubAIService([
				batchResponse({ index: 1, verdict: "match" }, { index: 2, verdict: "match" }),
			]);
			await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			const user = stub.userMessages[0];
			const pair1 = user.slice(user.indexOf('<pair index="1">'), user.indexOf('<pair index="2">'));
			assert.ok(pair1.includes("<terms>"), "訳文側ヒットでも terms が注入されること");
			assert.ok(pair1.includes("存在しない用語"), "原語が含まれること");
		});

		test("バッチ応答の一部欠落はリトライされ、部分受理で欠落分のみ error になる", async () => {
			const config = await initConfig({ batchSize: 3 });
			writePair();
			// 常に index 1 のみ返す → index 2 が揃わずリトライ枯渇 → 部分受理
			const incomplete = batchResponse({ index: 1, verdict: "match" });
			const stub = new StubAIService([incomplete, incomplete, incomplete]);
			const result = await executeAiReviewForFile(targetFile, config, buildVerifier(stub));

			assert.strictEqual(stub.callCount, 3, "初回 + リトライ2回");
			assert.strictEqual(result.approved, 1, "有効だった index 1 は採用されること");
			assert.strictEqual(result.errors, 1, "欠落した index 2 は安全側フォールバックで error になること");
			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"));
			assert.ok(written.includes("<!-- mdait tgtB from:srcB need:review -->"));
		});
	});
});
