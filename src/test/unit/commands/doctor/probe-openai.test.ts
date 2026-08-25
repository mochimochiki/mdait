// 診断が OpenAI 互換のエンドポイントを実際に確かめる部分のテスト。
//
// 以前はキーの文字列があるかどうかしか見ておらず、エンドポイント不達・キー誤り・
// モデル名の綴り違いのどれもが「問題なし」と返っていた。翻訳が失敗したときに
// 最初に押す道具なので、ここで切り分けられないと原因探しが振り出しに戻る。
//
// **分からないことは言わない**ことも一緒に固定する。/models を実装していない
// ゲートウェイの 404 を「モデルが無い」と言うと、今度は嘘の警告になる。

import * as assert from "node:assert";
import { probeOpenAi } from "../../../../commands/doctor/doctor-command";

const BASE = "https://api.example.com/v1";

suite("OpenAI 互換エンドポイントの疎通確認", () => {
	let originalFetch: typeof globalThis.fetch;
	let requestedUrl: string | undefined;

	setup(() => {
		originalFetch = globalThis.fetch;
		requestedUrl = undefined;
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
	});

	function stub(response: Response | Error): void {
		globalThis.fetch = (async (url: string) => {
			requestedUrl = String(url);
			if (response instanceof Error) {
				throw response;
			}
			return response;
		}) as unknown as typeof globalThis.fetch;
	}

	function models(ids: string[], status = 200): Response {
		return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	test("届かなければエラーとして、どこへ繋ごうとしたかを言う", async () => {
		stub(new Error("connect ECONNREFUSED"));

		const diag = await probeOpenAi(BASE, "sk-test", "gpt-test");

		assert.strictEqual(diag?.level, "error");
		assert.strictEqual(diag?.id, "ai.openaiUnreachable");
		assert.strictEqual(diag?.params?.endpoint, BASE);
	});

	test("キーが拒まれたらエラーとして、ステータスを添える", async () => {
		stub(new Response("", { status: 401 }));

		const diag = await probeOpenAi(BASE, "sk-wrong", "gpt-test");

		assert.strictEqual(diag?.level, "error");
		assert.strictEqual(diag?.id, "ai.openaiKeyRejected");
		assert.strictEqual(diag?.params?.status, "401");
	});

	test("一覧に無いモデル名は警告として、その名前を言う", async () => {
		stub(models(["gpt-a", "gpt-b"]));

		const diag = await probeOpenAi(BASE, "sk-test", "gpt-typo");

		assert.strictEqual(diag?.level, "warn");
		assert.strictEqual(diag?.id, "ai.openaiModelMissing");
		assert.strictEqual(diag?.params?.model, "gpt-typo");
	});

	test("一覧にあるモデル名なら何も言わない", async () => {
		stub(models(["gpt-a", "gpt-b"]));
		assert.strictEqual(await probeOpenAi(BASE, "sk-test", "gpt-a"), undefined);
	});

	test("/models を実装していないエンドポイント（404）では黙る（確かめられないので）", async () => {
		stub(new Response("", { status: 404 }));
		assert.strictEqual(await probeOpenAi(BASE, "sk-test", "gpt-typo"), undefined);
	});

	test("一覧が空なら、モデル名の判断はしない", async () => {
		stub(models([]));
		assert.strictEqual(await probeOpenAi(BASE, "sk-test", "gpt-typo"), undefined);
	});

	test("翻訳の本番経路ではなく models を叩く（診断で課金しない）", async () => {
		stub(models(["gpt-a"]));
		await probeOpenAi(`${BASE}/`, "sk-test", "gpt-a");
		assert.strictEqual(requestedUrl, `${BASE}/models`, "末尾のスラッシュも畳むこと");
	});
});
