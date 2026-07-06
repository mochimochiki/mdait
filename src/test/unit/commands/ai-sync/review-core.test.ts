import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PairVerifier } from "../../../../commands/ai-sync/pair-verifier";
import { executeAiReviewForFile } from "../../../../commands/ai-sync/review-core";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { Configuration } from "../../../../infra/config/configuration";
import { PromptProvider } from "../../../../prompts";

declare let __vscodeMockWorkspaceRoot: string;

/** 応答列を順番に返すスタブAIService（応答後フックでキャンセル等を注入できる） */
class StubAIService implements AIService {
	public callCount = 0;
	private readonly responses: string[];
	public afterResponse?: () => void;

	constructor(responses: string[]) {
		this.responses = responses;
	}

	async sendMessage(
		_systemPrompt: string,
		_messages: AIMessage[],
		_cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
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
				aiSync: { review: aiSyncReview },
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
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-ai-review-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		PromptProvider.dispose();
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

		test("audit で確定済みペアのドリフト（partial/mismatch）に need:review が付与される", async () => {
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
			assert.strictEqual(result.markersChanged, true);

			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(written.includes("<!-- mdait tgtA from:srcA need:review -->"), "ドリフトに need:review 付与");
			assert.ok(written.includes("<!-- mdait tgtB from:srcB -->"), "健全ペアは無変更");
			assert.ok(written.includes("Content A."), "本文は不変");
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

		test("audit の dryRun ではフラグを付与しない", async () => {
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

		test("audit はフラグ付与後も安定（2回目でドリフトは既に need:review、健全は無変更）", async () => {
			const config = await initConfig();
			writePair(SOURCE_CONTENT, SETTLED_TARGET_CONTENT);
			// 1回目: tgtA ドリフト→flag, tgtB 健全
			await executeAiReviewForFile(targetFile, config, buildVerifier(new StubAIService([MISMATCH, MATCH])), {
				mode: "audit",
			});
			const afterFirst = fs.readFileSync(targetFile, "utf-8");
			assert.ok(afterFirst.includes("<!-- mdait tgtA from:srcA need:review -->"));

			// 2回目 audit: tgtA は need:review として承認条件を満たさない mismatch のまま escalated、
			// tgtB は健全のまま audited。ファイル内容は安定。
			const second = await executeAiReviewForFile(
				targetFile,
				config,
				buildVerifier(new StubAIService([MISMATCH, MATCH])),
				{ mode: "audit" },
			);
			assert.strictEqual(second.escalated, 1, "既に need:review の tgtA は escalated 扱い");
			assert.strictEqual(second.audited, 1, "健全な tgtB は audited");
			assert.strictEqual(second.markersChanged, false);
			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), afterFirst);
		});
	});
});
