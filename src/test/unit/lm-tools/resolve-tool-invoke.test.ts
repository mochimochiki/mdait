// LM Tool を実際に invoke / prepareInvocation して、入力検証と確認UIの契約を固定する。
//
// ADR-260805-01 で「ツリー・CodeLens・LM Tool の3接点が同じ経路を通る」を不変条件にしたのに、
// 3つのうち LM Tool だけ実際に呼ぶテストが無かった。エンベロープの形（envelope.test.ts）と
// ソース走査の契約（tool-contract.test.ts）はあったが、**invoke を通した検証はここが最初**。
//
// mdait_resolve を題材にする。need の書き換えという「取り返しのつきにくい操作」を持ち、
// action が4種あって入力検証の分岐が一番多いため。他のツールも同じ型で足せる。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { Configuration } from "../../../infra/config/configuration";
import type { ToolEnvelope } from "../../../lm-tools/envelope";
import { MdaitResolveTool } from "../../../lm-tools/resolve-tool";

declare let __vscodeMockWorkspaceRoot: string;

/** invoke の戻り値からエンベロープを取り出す */
function readEnvelope(result: vscode.LanguageModelToolResult): ToolEnvelope<unknown> {
	const parts = (result as unknown as { content: Array<{ value: string }> }).content;
	assert.strictEqual(parts.length, 1, "本文は1パートで返す");
	return JSON.parse(parts[0].value) as ToolEnvelope<unknown>;
}

/** invoke を最小の呼び出し形で叩く */
async function invoke(
	tool: MdaitResolveTool,
	input: Record<string, unknown>,
): Promise<ToolEnvelope<unknown>> {
	const options = { input, toolInvocationToken: undefined } as unknown as Parameters<
		MdaitResolveTool["invoke"]
	>[0];
	const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;
	return readEnvelope(await tool.invoke(options, token));
}

/** prepareInvocation を最小の呼び出し形で叩く */
async function prepare(
	tool: MdaitResolveTool,
	input: Record<string, unknown>,
): Promise<vscode.PreparedToolInvocation> {
	const options = { input } as unknown as Parameters<MdaitResolveTool["prepareInvocation"]>[0];
	const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;
	return await tool.prepareInvocation(options, token);
}

suite("mdait_resolve の invoke（入力検証）", () => {
	let tempDir: string;
	let tool: MdaitResolveTool;

	setup(async () => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-lmtool-"));
		__vscodeMockWorkspaceRoot = tempDir;
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
			}),
			"utf-8",
		);
		await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "en", "doc.md"), "## A\n\nBody.\n", "utf-8");
		tool = new MdaitResolveTool();
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("path が空なら invalid_path で落ちること", async () => {
		const envelope = await invoke(tool, { path: "" });

		assert.strictEqual(envelope.ok, false);
		assert.strictEqual(envelope.error?.code, "invalid_path");
	});

	test("実在しない path なら invalid_path で落ちること", async () => {
		const envelope = await invoke(tool, { path: "en/missing.md" });

		assert.strictEqual(envelope.ok, false);
		assert.strictEqual(envelope.error?.code, "invalid_path");
	});

	test("ディレクトリを渡したら invalid_path で落ち、次の一手を示すこと", async () => {
		const envelope = await invoke(tool, { path: "en" });

		assert.strictEqual(envelope.ok, false);
		assert.strictEqual(envelope.error?.code, "invalid_path");
		assert.ok(
			envelope.nextActions?.some((a) => a.includes("mdait_getStatus")),
			"エージェントが次に何をすべきか分かること",
		);
	});

	test("needs に未知の語を渡したら invalid_input で落ちること", async () => {
		const envelope = await invoke(tool, { path: "en/doc.md", needs: ["reviewed"] });

		assert.strictEqual(envelope.ok, false);
		assert.strictEqual(envelope.error?.code, "invalid_input");
		assert.ok(envelope.error?.message.includes("reviewed"), "どの値が悪いか示すこと");
	});

	for (const action of ["keep", "delete", "declare-isolate"] as const) {
		test(`action:"${action}" で unitHashes が無ければ invalid_input で落ちること`, async () => {
			// 省略してファイル内全件へ暗黙に効かせる経路は作らない（意図せぬ一括操作の安全弁）
			const envelope = await invoke(tool, { path: "en/doc.md", action });

			assert.strictEqual(envelope.ok, false);
			assert.strictEqual(envelope.error?.code, "invalid_input");
		});

		test(`action:"${action}" で unitHashes が空配列でも invalid_input で落ちること`, async () => {
			const envelope = await invoke(tool, { path: "en/doc.md", action, unitHashes: [] });

			assert.strictEqual(envelope.ok, false);
			assert.strictEqual(envelope.error?.code, "invalid_input");
		});
	}
});

suite("mdait_resolve の prepareInvocation（確認UIの契約）", () => {
	let tempDir: string;
	let tool: MdaitResolveTool;

	setup(async () => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-lmtool-prep-"));
		__vscodeMockWorkspaceRoot = tempDir;
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
			}),
			"utf-8",
		);
		await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
		tool = new MdaitResolveTool();
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// マーカーを書き換える操作は AI 不使用でも必ず確認を経由する（ADR-260705-01）
	for (const action of [undefined, "resolve", "keep", "delete", "declare-isolate"] as const) {
		test(`action:${action ?? "（省略）"} でも確認メッセージが必ず付くこと`, async () => {
			const input: Record<string, unknown> = { path: "en/doc.md", unitHashes: ["abc12345"] };
			if (action) {
				input.action = action;
			}

			const prepared = await prepare(tool, input);

			assert.ok(prepared.invocationMessage, "実行中の表示がある");
			assert.ok(prepared.confirmationMessages, "確認を飛ばさない");
			assert.ok(prepared.confirmationMessages?.title, "確認に見出しがある");
			assert.ok(prepared.confirmationMessages?.message, "確認に説明がある");
		});
	}

	test("削除の確認は取り消せないことを伝えること", async () => {
		const prepared = await prepare(tool, {
			path: "en/doc.md",
			action: "delete",
			unitHashes: ["abc12345"],
		});

		const message = String(prepared.confirmationMessages?.message ?? "");
		assert.ok(message.includes("cannot be undone"), "取り返しがつかないことを伝える");
	});

	test("AI を使わないことを確認文で伝えること", async () => {
		// 定常操作と AI 操作の区別はユーザーが判断する材料になる（ADR-260705-01）
		for (const action of ["keep", "delete", "declare-isolate"] as const) {
			const prepared = await prepare(tool, {
				path: "en/doc.md",
				action,
				unitHashes: ["abc12345"],
			});
			const message = String(prepared.confirmationMessages?.message ?? "");
			assert.ok(message.includes("No AI is used"), `action:${action} で AI 不使用を明示する`);
		}
	});
});
