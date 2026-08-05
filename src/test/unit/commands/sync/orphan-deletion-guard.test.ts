/**
 * 孤立ユニットの自動削除を「崩れ」と疑って見送るガードのテスト（ADR-260804-01）。
 *
 * 守りたいのは「原文のパースが崩れて、訳文の章がまとめて対応を失った」場面である。
 * 一方で、**普通の編集で対応が1件外れただけ**のときに見送ってしまうと、古い章が
 * `need:verify-deletion` として本文に残り、訳文に章が重複する。
 * ユニット数の小さい文書ではこの2つが紛らわしいので、ここで両方を固定する。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

suite("孤立ユニット自動削除の見送りガード", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-guard-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function initConfig(): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		return config;
	}

	function parseUnits(filePath: string) {
		return markdownParser.parse(fs.readFileSync(filePath, "utf-8"), Configuration.getInstance()).units;
	}

	function docOf(chapters: readonly { title: string; body: string }[]): string {
		const lines = ["# 手引き", "", "導入の本文。", ""];
		for (const c of chapters) {
			lines.push(`## ${c.title}`, "", c.body, "");
		}
		return lines.join("\n");
	}

	/**
	 * 原文の本文の一部だけを書き換える（マーカー行には触らない）。
	 * ファイルを丸ごと書き直すとマーカーごと消えてしまい、実際の編集とは別の状況になる。
	 */
	function editSourceBody(from: string, to: string): void {
		const content = fs.readFileSync(sourceFile, "utf-8");
		assert.ok(content.includes(from), `編集対象が見つからない: ${from}`);
		fs.writeFileSync(sourceFile, content.replace(from, to), "utf-8");
	}

	test("2ユニットの文書で1章を編集しても、訳文に古い章が残らないこと", async () => {
		// 原文が2ユニット（H1 + 1章）しかないと、1章を編集しただけで
		// 「対応が付いたのは1件」になる。これを崩れと読むと、古い章が
		// need:verify-deletion で本文に残り、訳文に同じ章が2つ並ぶ
		const config = await initConfig();
		fs.writeFileSync(sourceFile, docOf([{ title: "第1章", body: "第1章の本文。" }]), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 2, "前提: 訳文は2ユニット");

		editSourceBody("第1章の本文。", "第1章の本文（改訂）。");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 2, `訳文は2ユニットのまま（重複しない）: ${units.map((u) => u.title).join(" / ")}`);
		assert.strictEqual(
			units.filter((u) => u.marker?.need === "verify-deletion").length,
			0,
			"普通の編集で確認待ちを作らない",
		);
		assert.strictEqual(diff.orphanDeletionWithheld ?? 0, 0, "見送りは発生しない");
	});

	test("マーカーを失った原文に差し替えて1章編集しても、訳文に古い章が残らないこと", async () => {
		// 原文をバックアップや git から書き戻す・external から素の Markdown を貼るなどで
		// 本文のマーカーが無くなると、編集された章は from 一致で結べず「孤立1件＋新規1件」になる。
		// このとき「対応が付いた数」で崩れを判定すると、2ユニットの文書では必ず誤爆する
		const config = await initConfig();
		fs.writeFileSync(sourceFile, docOf([{ title: "第1章", body: "第1章の本文。" }]), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 2, "前提: 訳文は2ユニット");

		// マーカーを含まない本文で丸ごと差し替える（＝マーカーが失われた状態での編集）
		fs.writeFileSync(sourceFile, docOf([{ title: "第1章", body: "第1章の本文（改訂）。" }]), "utf-8");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 2, `訳文は2ユニットのまま（重複しない）: ${units.map((u) => u.title).join(" / ")}`);
		assert.strictEqual(diff.orphanDeletionWithheld ?? 0, 0, "原文の構造は潰れていないので見送らない");
	});

	test("3ユニットの文書で2章とも編集しても、訳文に古い章が残らないこと", async () => {
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			docOf([
				{ title: "第1章", body: "第1章の本文。" },
				{ title: "第2章", body: "第2章の本文。" },
			]),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 3, "前提: 訳文は3ユニット");

		editSourceBody("第1章の本文。", "第1章の本文（改訂）。");
		editSourceBody("第2章の本文。", "第2章の本文（改訂）。");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 3, `訳文は3ユニットのまま: ${units.map((u) => u.title).join(" / ")}`);
		assert.strictEqual(diff.orphanDeletionWithheld ?? 0, 0, "見送りは発生しない");
	});

	test("原文がコードブロックの閉じ忘れで潰れたら、訳文の章を削除せず確認待ちにすること", async () => {
		// 原文の構造そのものが1ユニットへ潰れる場面。ここは見送らなければならない
		const config = await initConfig();
		const original = docOf([
			{ title: "第1章", body: "第1章の本文。" },
			{ title: "第2章", body: "第2章の本文。" },
		]);
		fs.writeFileSync(sourceFile, original, "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 3, "前提: 訳文は3ユニット");

		editSourceBody("導入の本文。", "導入の本文。\n\n```text");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 3, "訳文の本文が物理削除されないこと");
		assert.ok((diff.orphanDeletionWithheld ?? 0) > 0, "自動削除を見送ったことが結果に出ること");
		assert.strictEqual(
			units.filter((u) => u.marker?.need === "verify-deletion").length,
			2,
			"対応を失った2章が確認待ちになること",
		);
	});

	test("原文の崩れを直すと確認待ちが自動で解けること", async () => {
		const config = await initConfig();
		const original = docOf([
			{ title: "第1章", body: "第1章の本文。" },
			{ title: "第2章", body: "第2章の本文。" },
		]);
		fs.writeFileSync(sourceFile, original, "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);
		fs.writeFileSync(sourceFile, original.replace("導入の本文。", "導入の本文。\n\n```text"), "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		fs.writeFileSync(sourceFile, original, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 3);
		assert.strictEqual(
			units.filter((u) => u.marker?.need === "verify-deletion").length,
			0,
			"原文が戻れば確認待ちは残らない",
		);
	});

	test("原文から章をまとめて削除したときは確認待ちにすること", async () => {
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			docOf([
				{ title: "第1章", body: "第1章の本文。" },
				{ title: "第2章", body: "第2章の本文。" },
				{ title: "第3章", body: "第3章の本文。" },
				{ title: "第4章", body: "第4章の本文。" },
				{ title: "第5章", body: "第5章の本文。" },
			]),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 6);

		fs.writeFileSync(sourceFile, docOf([{ title: "第1章", body: "第1章の本文。" }]), "utf-8");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 6, "訳文は残る（人が確定するまで消さない）");
		assert.ok((diff.orphanDeletionWithheld ?? 0) > 0);
	});

	test("原文を空にしたら訳文を消さず、書き戻せば通常どおり同期されること", async () => {
		// `.mdait` を git 管理外にしている運用・新しいクローン・キャッシュ削除では
		// 「マーカーの無い原文」が普通に現れる。書き戻したあとに確認待ちが残ってはいけない
		const config = await initConfig();
		const original = docOf([
			{ title: "第1章", body: "第1章の本文。" },
			{ title: "第2章", body: "第2章の本文。" },
		]);
		fs.writeFileSync(sourceFile, original, "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		fs.writeFileSync(sourceFile, "", "utf-8");
		const emptied = await sync_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 3, "原文が空でも訳文を消さない");
		// 訳文を守る関門は2つあり、原文が空のときは手前の「原文に本文が無いので中止」
		// （ADR-260803-06）が先に効いて、孤立の判定まで進まない。どちらが働いたかは
		// 問わず、どちらも働かなければ落ちるように書く（機構ではなく結果を固定する）。
		assert.ok(
			(emptied.sourceEmptied ?? 0) > 0 || (emptied.orphanDeletionWithheld ?? 0) > 0,
			"原文が空のとき、中止と見送りのどちらの関門も働いていない",
		);

		fs.writeFileSync(sourceFile, original, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		const units = parseUnits(targetFile);
		assert.strictEqual(units.length, 3, `書き戻したら元の数に戻る: ${units.map((u) => u.title).join(" / ")}`);
		assert.strictEqual(
			units.filter((u) => u.marker?.need === "verify-deletion").length,
			0,
			"書き戻したら確認待ちは残らない",
		);
	});

	test("訳文に独立ユニットが多くあっても、普通の削除の判断が変わらないこと", async () => {
		// 独立ユニット（原文を持たない訳文だけの章）は自動削除の対象外なので、
		// 「原文の構造が潰れたか」を測る分母にも数えてはいけない
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			docOf([
				{ title: "第1章", body: "第1章の本文。" },
				{ title: "第2章", body: "第2章の本文。" },
			]),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		// 訳文だけの章を4つ足す（マーカー無し → 一次受けで独立ユニットになる）
		fs.appendFileSync(
			targetFile,
			["", "## Extra A", "", "Only in English.", "", "## Extra B", "", "Only in English.", ""].join("\n"),
			"utf-8",
		);
		await sync_CoreProc(sourceFile, targetFile, config);
		const baseline = parseUnits(targetFile).length;

		// 原文から第2章だけを消す（普通の削除）
		fs.writeFileSync(sourceFile, docOf([{ title: "第1章", body: "第1章の本文。" }]), "utf-8");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.orphanDeletionWithheld ?? 0, 0, "独立ユニットの数に引きずられない");
		assert.strictEqual(parseUnits(targetFile).length, baseline - 1, "消えるのは対応を失った1章だけ");
	});

	test("章を1つだけ削除したときは従来どおり自動削除すること", async () => {
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			docOf([
				{ title: "第1章", body: "第1章の本文。" },
				{ title: "第2章", body: "第2章の本文。" },
				{ title: "第3章", body: "第3章の本文。" },
			]),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(parseUnits(targetFile).length, 4);

		fs.writeFileSync(
			sourceFile,
			docOf([
				{ title: "第1章", body: "第1章の本文。" },
				{ title: "第2章", body: "第2章の本文。" },
			]),
			"utf-8",
		);
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(parseUnits(targetFile).length, 3, "普通の削除は自動削除のまま");
		assert.strictEqual(diff.orphanDeletionWithheld ?? 0, 0);
	});
});
