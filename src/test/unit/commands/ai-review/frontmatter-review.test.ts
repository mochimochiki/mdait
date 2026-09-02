/**
 * 取り込み（adopt）で確認待ちになった frontmatter を、AI 翻訳レビューが本文と同じように
 * 片づけることの回帰テスト。
 *
 * 背景: adopt は本文にも frontmatter にも `need:review` を付ける（ADR-260902-02）。
 * ところが AI 翻訳レビューは本文ユニットだけを列挙していたため、AI が本文を全部承認しても
 * **frontmatter の確認待ちだけがツリーに残った**（実測。実 LLM で取り込みを一気通しした
 * ときの `.mdait/reports/adopt.md` は本文8件を判定し、frontmatter は1件も見ていない）。
 * 「AI が整える」が最後の1件で途切れる。
 *
 * ここは実経路（sync の取り込み → executeAiReviewForFile）を通し、embedded と external の
 * 両方で確かめる。frontmatter のマーカーはパースのたびに作り直される別物なので、
 * 承認しても書き戻しを忘れれば確認待ちのまま残る — その取りこぼしを見張る。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { PairVerifier } from "../../../../commands/ai-review/pair-verifier";
import { executeAiReviewForFile } from "../../../../commands/ai-review/review-core";
import { sync_CoreProc } from "../../../../commands/sync/sync-command";
import { parseFrontmatterMarker } from "../../../../core/markdown/frontmatter-translation";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { resolveMarkerIOForFile } from "../../../../infra/config/marker-io";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { PromptProvider } from "../../../../prompts";

declare let __vscodeMockWorkspaceRoot: string;

const MATCH = '{"verdict": "match", "confidence": 0.95, "issues": [], "reason": "Complete."}';
const MISMATCH = '{"verdict": "mismatch", "confidence": 0.9, "issues": [], "reason": "Different topics."}';

const SOURCE = ["---", 'title: "インストール"', 'description: "動作環境と導入手順"', "---", "# インストール", "", "手順を説明します。", ""].join(
	"\n",
);

const TARGET = [
	"---",
	'title: "Installation"',
	'description: "Requirements and setup steps"',
	"---",
	"# Installation",
	"",
	"This section describes the installation steps.",
	"",
].join("\n");

/** 同じ応答を返し続けるスタブ。渡された user メッセージを全部覚える */
class StubAIService implements AIService {
	public userMessages: string[] = [];
	constructor(private readonly response: string) {}
	async sendMessage(
		_systemPrompt: string,
		messages: AIMessage[],
		_cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		this.userMessages.push(String(messages[messages.length - 1]?.content ?? ""));
		return this.response;
	}
}

for (const mode of ["embedded", "external"] as const) {
	suite(`AI翻訳レビュー: frontmatter の確認待ちも片づける（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			PromptProvider.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-fm-review-"));
			__vscodeMockWorkspaceRoot = tempDir;
			fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
			fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
			sourceFile = path.join(tempDir, "ja", "doc.md");
			targetFile = path.join(tempDir, "en", "doc.md");
		});

		teardown(() => {
			Configuration.dispose();
			PromptProvider.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		/** 取り込み済みの対訳を1組そろえる */
		async function adopt(): Promise<Configuration> {
			const mdaitDir = path.join(tempDir, ".mdait");
			fs.mkdirSync(mdaitDir, { recursive: true });
			const configPath = path.join(mdaitDir, "mdait.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
					primaryLang: "ja",
					markers: { mode },
					sync: { level: 3 },
					ai: { provider: "default" },
					aiReview: { batchSize: 1 },
					trans: { frontmatter: { keys: ["title", "description"] } },
				}),
				"utf-8",
			);
			const config = Configuration.getInstance();
			await config.initialize(configPath);
			UnitStateStore.getInstance().load(mdaitDir);
			fs.writeFileSync(sourceFile, SOURCE, "utf-8");
			fs.writeFileSync(targetFile, TARGET, "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });
			assert.strictEqual(frontmatterMarker()?.need, "review", "取り込み直後は確認待ちであること");
			return config;
		}

		/** 訳文側の frontmatter マーカーを読む（保管方式に依らず同じ読み口を通す） */
		function frontmatterMarker() {
			const config = Configuration.getInstance();
			const io = resolveMarkerIOForFile(config, targetFile);
			const doc = markdownParser.parse(fs.readFileSync(targetFile, "utf-8"), config, io.provider, io.ctx);
			return parseFrontmatterMarker(doc.frontMatter);
		}

		function verifierOf(stub: StubAIService): PairVerifier {
			const promptProvider = PromptProvider.getInstance();
			return new PairVerifier(stub, (id, variables) => promptProvider.getPromptParts(id, variables));
		}

		test("承認されると frontmatter の need:review が外れる", async () => {
			const config = await adopt();
			const stub = new StubAIService(MATCH);

			const result = await executeAiReviewForFile(targetFile, config, verifierOf(stub));

			assert.strictEqual(frontmatterMarker()?.need, null, "確認待ちが残らないこと");
			assert.ok(
				result.unitResults.some((unit) => unit.title === "front matter" && unit.action === "approved"),
				"レポートにも frontmatter の1件が現れること",
			);
		});

		test("判定にかけるのは翻訳対象キーの値だけ", async () => {
			const config = await adopt();
			const stub = new StubAIService(MATCH);

			await executeAiReviewForFile(targetFile, config, verifierOf(stub));

			const sent = stub.userMessages.find((message) => message.includes("title: Installation"));
			assert.ok(sent, "訳文側の title を送っていること");
			assert.ok(sent.includes("title: インストール"), "原文側の title も送っていること");
			assert.ok(sent.includes("description: Requirements and setup steps"));
		});

		test("承認されなければ frontmatter は確認待ちのまま残る", async () => {
			const config = await adopt();

			await executeAiReviewForFile(targetFile, config, verifierOf(new StubAIService(MISMATCH)));

			assert.strictEqual(frontmatterMarker()?.need, "review", "人が見るまで外さないこと");
		});

		test("2回目の実行では frontmatter も対象にならない（冪等）", async () => {
			const config = await adopt();
			await executeAiReviewForFile(targetFile, config, verifierOf(new StubAIService(MATCH)));

			const second = await executeAiReviewForFile(targetFile, config, verifierOf(new StubAIService(MATCH)));

			assert.strictEqual(second.verified, 0);
			assert.strictEqual(second.markersChanged, false);
		});

		test("訳文の title / description は承認しても書き換わらない", async () => {
			const config = await adopt();

			await executeAiReviewForFile(targetFile, config, verifierOf(new StubAIService(MATCH)));

			const written = fs.readFileSync(targetFile, "utf-8");
			assert.match(written, /title: "Installation"/);
			assert.match(written, /description: "Requirements and setup steps"/);
		});
	});
}
