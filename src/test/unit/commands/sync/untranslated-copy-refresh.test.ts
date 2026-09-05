/**
 * まだ訳していない訳文（原文の丸写し）が、原文の変化に追随することの回帰テスト。
 *
 * 背景: sync は原文が変わると訳文の `from` を新しい原文へ進めるが、**まだ訳していない
 * ユニットの本文は古い原文の丸写しのまま**だった。訳文に古い原文が残り続けるので、
 * 読む人にはそれが訳文に見えるし、サイトを建てれば古い内容がそのまま公開される。
 * `need:translate` のまま `hash`（訳文の中身）と `from`（原文の中身）が食い違うため、
 * 未訳の丸写しと人が書きかけた訳文が同じ形になり、訳文を見ただけでは区別も付かなくなる。
 *
 * **「未訳の訳文は今の原文の丸写しである」という不変条件を sync が保つ**ようにした。
 * 写し直してよい根拠は「その訳文に人の仕事が入っていない」ことだけなので、
 * 丸写しであることを確かめたユニットにしか触らない。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

const SOURCE = [
	"# 製品ガイド",
	"",
	"この製品の概要を説明します。",
	"",
	"## インストール",
	"",
	"インストール手順を説明します。",
	"",
	"## 使い方",
	"",
	"基本的な使い方を説明します。",
	"",
].join("\n");

/** 真ん中の章を書き換える（見出しも本文も動かす） */
function reviseSource(file: string): void {
	const revised = fs
		.readFileSync(file, "utf-8")
		.replace("## インストール", "## インストール（改訂）")
		.replace("インストール手順を説明します。", "インストール手順を説明します。前提条件も確認してください。");
	fs.writeFileSync(file, revised, "utf-8");
}

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: 未訳の丸写しは変わった原文へ追随する（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-untranslated-copy-"));
			__vscodeMockWorkspaceRoot = tempDir;
			fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
			fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
			sourceFile = path.join(tempDir, "ja", "doc.md");
			targetFile = path.join(tempDir, "en", "doc.md");
		});

		teardown(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		/** 設定を書いて原文を置き、訳文を作るところまで進める（訳文は全ユニット need:translate） */
		async function bootstrap(): Promise<Configuration> {
			const mdaitDir = path.join(tempDir, ".mdait");
			fs.mkdirSync(mdaitDir, { recursive: true });
			const configPath = path.join(mdaitDir, "mdait.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
					primaryLang: "ja",
					markers: { mode },
					sync: { level: 3, autoDelete: true },
				}),
				"utf-8",
			);
			const config = Configuration.getInstance();
			await config.initialize(configPath);
			UnitStateStore.getInstance().load(mdaitDir);
			fs.writeFileSync(sourceFile, SOURCE, "utf-8");
			await syncNew_CoreProc(sourceFile, targetFile, config);
			return config;
		}

		/** 訳文ユニットの (hash, from, need)。embedded は本文から、external は外の台帳から読む */
		function targetMarkers(): Array<{ hash: string; from: string; need: string }> {
			if (mode === "embedded") {
				const text = fs.readFileSync(targetFile, "utf-8");
				return [...text.matchAll(/<!-- mdait ([0-9a-f]+)(?: from:([0-9a-f]+))?(?: need:([\w@-]+))? -->/g)].map(
					(matched) => ({ hash: matched[1], from: matched[2] ?? "", need: matched[3] ?? "" }),
				);
			}
			return UnitStateStore.getInstance()
				.getEntriesByPath("en/doc.md")
				.filter((entry) => entry.order < 1_000_000) // frontmatter の予約席は本文ユニットではない
				.map((entry) => ({ hash: entry.hash, from: entry.from, need: entry.need }));
		}

		/** 訳文の本文（マーカーの行を除く） */
		function targetBody(): string {
			return fs
				.readFileSync(targetFile, "utf-8")
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("<!-- mdait"))
				.join("\n");
		}

		test("訳文を作った直後は、全ユニットが原文と一致する（前提）", async () => {
			await bootstrap();
			for (const marker of targetMarkers()) {
				assert.strictEqual(marker.need, "translate", "作った訳文はまだ全部未訳である");
				assert.strictEqual(marker.hash, marker.from, "未訳の訳文は原文の丸写しなので hash と from が一致する");
			}
		});

		test("原文が変わると、未訳の丸写しも新しい原文へ写し直される", async () => {
			const config = await bootstrap();
			reviseSource(sourceFile);

			const result = await sync_CoreProc(sourceFile, targetFile, config);

			assert.ok(targetBody().includes("## インストール（改訂）"), "訳文の丸写しが古い原文のまま取り残されない");
			assert.ok(targetBody().includes("前提条件も確認してください。"), "本文の追記も写し直される");
			assert.strictEqual(result.modified, 1, "訳文の中身を書き換えたことを数えて伝える");
			for (const marker of targetMarkers()) {
				assert.strictEqual(marker.need, "translate", "写し直しても未訳のままである（勝手に完了にしない）");
				assert.strictEqual(
					marker.hash,
					marker.from,
					"未訳の訳文は今の原文の丸写しなので hash と from が一致する",
				);
			}
		});

		test("写し直したあと、もう一度 sync しても何も変わらない（冪等）", async () => {
			const config = await bootstrap();
			reviseSource(sourceFile);
			await sync_CoreProc(sourceFile, targetFile, config);
			const bodyAfterFirst = targetBody();

			const second = await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(second.modified, 0, "2回目は書き換えるものが無い");
			assert.strictEqual(targetBody(), bodyAfterFirst);
		});

		test("人が書きかけた訳文には触らない（未訳でも中身が丸写しでなければ守る）", async () => {
			const config = await bootstrap();
			fs.writeFileSync(
				targetFile,
				fs.readFileSync(targetFile, "utf-8").replace("## インストール", "## Installation (draft by hand)"),
				"utf-8",
			);
			// 前提はディスクから読み直して確かめる。書き込む前の文字列で確かめると、
			// 書けていなくてもこのテストが通ってしまう（レビュー指摘）
			assert.ok(targetBody().includes("## Installation (draft by hand)"), "書きかけの訳文を置いた（前提）");
			reviseSource(sourceFile);

			await sync_CoreProc(sourceFile, targetFile, config);

			assert.ok(
				targetBody().includes("## Installation (draft by hand)"),
				"人が書いた訳文を原文で上書きしてはならない",
			);
		});

		test("訳し終えたユニットは写し直さず、改訂待ちになる", async () => {
			const config = await bootstrap();
			// 真ん中の章だけ「訳し終えた」状態にする（本文を英語にし、need を外す）
			await sync_CoreProc(sourceFile, targetFile, config);
			const translated = fs
				.readFileSync(targetFile, "utf-8")
				.replace("## インストール\n\nインストール手順を説明します。", "## Installation\n\nInstall it like this.");
			fs.writeFileSync(targetFile, translated, "utf-8");
			if (mode === "embedded") {
				fs.writeFileSync(
					targetFile,
					fs.readFileSync(targetFile, "utf-8").replace(/ need:translate -->\n## Installation/, " -->\n## Installation"),
					"utf-8",
				);
			} else {
				const store = UnitStateStore.getInstance();
				const entries = store.getEntriesByPath("en/doc.md");
				const target = entries.find((entry) => entry.order === 1);
				if (target) {
					store.setEntry({ ...target, need: "" });
				}
			}
			await sync_CoreProc(sourceFile, targetFile, config);
			reviseSource(sourceFile);

			await sync_CoreProc(sourceFile, targetFile, config);

			assert.ok(targetBody().includes("Install it like this."), "訳し終えた本文を原文で上書きしてはならない");
			assert.ok(
				targetMarkers().some((marker) => marker.need.startsWith("revise@")),
				"訳し終えたユニットの原文が変われば改訂待ちになる",
			);
		});
	});
}

/**
 * `from` が既に先へ進んでしまった訳文の救済。
 *
 * この修正が入る前の sync が作った状態がそのまま手元に残っているため、**写し直しの機会を
 * すでに逃した**ユニットがある（`from` は今の原文を指しているので「原文が変わった」では
 * 拾えない）。その形は手編集と見分けが付かないので、`unit-state` ではなく
 * `unit-registry`（sync のたびに原文ユニットの中身を控えている）へ問い合わせ、
 * **過去の原文そのものだったか**を中身まで突き合わせて確かめる。
 *
 * 壊れた状態を手で作る必要があるため、マーカーが本文にある embedded でのみ確かめる。
 * 判定はマーカーの読み書きより手前にあるので、置き場所によって変わらない。
 */
suite("sync: from が先へ進んでしまった未訳の丸写しも救済される（embedded）", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-untranslated-repair-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("訳文が過去の原文そのものなら、今の原文へ写し直される", async () => {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode: "embedded" },
				sync: { level: 3, autoDelete: true },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);
		fs.writeFileSync(sourceFile, SOURCE, "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// 原文を変え、**訳文の from だけ**新しい原文へ進める（この修正が入る前の sync の帰結）
		reviseSource(sourceFile);
		await sync_CoreProc(sourceFile, targetFile, config);
		const newSourceHash = /<!-- mdait ([0-9a-f]+) -->\n## インストール（改訂）/.exec(
			fs.readFileSync(sourceFile, "utf-8"),
		)?.[1];
		assert.ok(newSourceHash, "新しい原文のハッシュが読めること（前提）");
		const staleTarget = fs
			.readFileSync(targetFile, "utf-8")
			.replace("## インストール（改訂）\n\nインストール手順を説明します。前提条件も確認してください。", "## インストール\n\nインストール手順を説明します。");
		fs.writeFileSync(targetFile, staleTarget, "utf-8");

		const result = await sync_CoreProc(sourceFile, targetFile, config);

		const body = fs
			.readFileSync(targetFile, "utf-8")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("<!-- mdait"))
			.join("\n");
		assert.ok(body.includes("## インストール（改訂）"), "過去の原文の丸写しは今の原文へ写し直される");
		assert.strictEqual(result.modified, 1, "写し直した件数を数えて伝える");
	});
});
