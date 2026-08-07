// ファイルの移動にペアと unit-state の行を追随させる入口の検証（roadmap-v01 の P02）。
//
// 計画そのもの（ペアの導出・重複の排除・行き先の衝突）は core の純粋関数として
// rename-plan.test.ts で固定してある。ここで見るのは **VS Code の2つのイベントを
// またぐ受け渡し**である。ファイルを動かせるのは移動の前（onWillRenameFiles）だけ、
// 行を付け替えてよいのは移動が済んだあと（onDidRenameFiles）だけ、という制約から
// 計画を控えて持ち越す必要があり、その受け渡しが外れると「訳文は動いたのに行は
// 旧パスのまま」という、いちばん見つけにくい壊れ方になる。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildRenameFollowEdit, completeRenameFollow } from "../../../../commands/markers/rename-follow";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { resetUnitStateLock } from "../../../../infra/workspace/unit-state-lock";

declare let __vscodeMockWorkspaceRoot: string;

/** モックの WorkspaceEdit が控えるリネーム（テストからのみ見える） */
interface RecordedEdit {
	renamedFiles: Array<{
		oldUri: vscode.Uri;
		newUri: vscode.Uri;
		options?: { overwrite?: boolean; ignoreIfExists?: boolean };
	}>;
}

suite("移動への追随（onWillRenameFiles / onDidRenameFiles）", () => {
	let tempDir: string;
	let mdaitDir: string;

	const abs = (rel: string): string => path.join(tempDir, rel);
	const uris = (...moves: Array<[string, string]>) =>
		moves.map(([from, to]) => ({ oldUri: vscode.Uri.file(abs(from)), newUri: vscode.Uri.file(abs(to)) }));

	/** ワークスペースにファイルを置く */
	function place(rel: string, content = "# Doc\n\nBody.\n"): void {
		const target = abs(rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf-8");
	}

	/** ディスク上でも移動させる（VS Code が waitUntil の編集を適用したあとに相当） */
	function moveOnDisk(from: string, to: string): void {
		fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
		fs.renameSync(abs(from), abs(to));
	}

	async function initConfig(pairs?: Array<Record<string, string>>): Promise<void> {
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: pairs ?? [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode: "external" },
			}),
			"utf-8",
		);
		await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
	}

	/** unit-state に1行置く（非MD相当の単一ユニット形。付け替えだけを見るので中身は問わない） */
	function seedEntry(relPath: string, need = "review"): void {
		UnitStateStore.getInstance().setEntry({
			path: relPath,
			order: 0,
			level: 0,
			titleHash: "",
			hash: "h0",
			from: "f0",
			need,
		});
	}

	setup(async () => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		resetUnitStateLock();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-rename-follow-"));
		mdaitDir = path.join(tempDir, ".mdait");
		__vscodeMockWorkspaceRoot = tempDir;
		await initConfig();
		UnitStateStore.getInstance().load(mdaitDir);
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		resetUnitStateLock();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("原文のリネームに、訳文のリネームを同じ編集へ載せること", () => {
		place("ja/guide.md");
		place("en/guide.md");

		const edit = buildRenameFollowEdit(uris(["ja/guide.md", "ja/handbook.md"])) as unknown as RecordedEdit;

		assert.strictEqual(edit.renamedFiles.length, 1, "訳文の移動が1件載ること");
		assert.strictEqual(edit.renamedFiles[0].oldUri.fsPath, abs("en/guide.md"));
		assert.strictEqual(edit.renamedFiles[0].newUri.fsPath, abs("en/handbook.md"));
	});

	test("追随の失敗がユーザーのリネームを巻き添えにしない条件で載せること", () => {
		// 計画を立ててから編集が適用されるまでの隙に行き先が作られると、
		// `ignoreIfExists` が無い限りその1件の失敗がリネーム全体を道連れにする。
		// `overwrite` は `ignoreIfExists` に優先するので、false のままでなければ
		// 行き先の訳文が上書きで消える（しかもごみ箱を経由しない）
		place("ja/guide.md");
		place("en/guide.md");

		const edit = buildRenameFollowEdit(uris(["ja/guide.md", "ja/handbook.md"])) as unknown as RecordedEdit;

		assert.deepStrictEqual(edit.renamedFiles[0].options, { overwrite: false, ignoreIfExists: true });
	});

	test("行き先の訳文が既にあるときは編集に載せないこと（上書きで訳文を失わない）", () => {
		place("ja/guide.md");
		place("en/guide.md");
		place("en/handbook.md");

		const edit = buildRenameFollowEdit(uris(["ja/guide.md", "ja/handbook.md"])) as unknown as RecordedEdit;

		assert.deepStrictEqual(edit.renamedFiles, []);
	});

	test("移動が済んだあとに、原文と訳文の両方の行が新しいパスへ付け替わること", async () => {
		place("ja/guide.md");
		place("en/guide.md");
		seedEntry("ja/guide.md", "");
		seedEntry("en/guide.md", "review");

		const files = uris(["ja/guide.md", "ja/handbook.md"]);
		buildRenameFollowEdit(files);
		// VS Code が編集を適用した状態を作る（原文はユーザーぶん、訳文は連れて動くぶん）
		moveOnDisk("ja/guide.md", "ja/handbook.md");
		moveOnDisk("en/guide.md", "en/handbook.md");
		await completeRenameFollow(files);

		const store = UnitStateStore.getInstance();
		assert.strictEqual(store.getEntry("ja/guide.md", 0), undefined);
		assert.strictEqual(store.getEntry("en/guide.md", 0), undefined);
		assert.ok(store.getEntry("ja/handbook.md", 0), "原文の行が追随すること");
		assert.strictEqual(store.getEntry("en/handbook.md", 0)?.need, "review", "need を保ったまま追随すること");
	});

	test("付け替えた結果がディスクへ保存されること（次の sync の load に捨てられない）", async () => {
		place("ja/guide.md");
		place("en/guide.md");
		seedEntry("en/guide.md", "review");

		const files = uris(["ja/guide.md", "ja/handbook.md"]);
		buildRenameFollowEdit(files);
		moveOnDisk("ja/guide.md", "ja/handbook.md");
		moveOnDisk("en/guide.md", "en/handbook.md");
		await completeRenameFollow(files);

		// syncCommand は毎回 load() を無条件に呼ぶ。保存されていなければここで消える
		UnitStateStore.getInstance().load(mdaitDir);
		assert.strictEqual(UnitStateStore.getInstance().getEntry("ja/guide.md", 0), undefined);
		assert.strictEqual(UnitStateStore.getInstance().getEntry("en/handbook.md", 0)?.need, "review");
	});

	test("onWillRenameFiles を通っていない移動でも、届いたぶんの行は付け替えること", async () => {
		// 他の拡張が動かした等。訳文を連れて動かす機会は過ぎているが、行まで取り残す理由は無い
		place("en/handbook.md");
		seedEntry("en/guide.md", "review");

		await completeRenameFollow(uris(["en/guide.md", "en/handbook.md"]));

		const store = UnitStateStore.getInstance();
		assert.strictEqual(store.getEntry("en/guide.md", 0), undefined);
		assert.strictEqual(store.getEntry("en/handbook.md", 0)?.need, "review");
	});

	test("取り消しで戻ったとき、報せに訳文が無くても訳文の行が一緒に戻ること", async () => {
		// Ctrl+Z はこちらが足した訳文の移動もまとめて巻き戻すが、そのときエディタが
		// 何を「移動した」と報せてくるかは保証されていない。行は実測で合わせる
		place("ja/guide.md");
		place("en/guide.md");
		seedEntry("ja/handbook.md", "");
		seedEntry("en/handbook.md", "review");

		await completeRenameFollow(uris(["ja/handbook.md", "ja/guide.md"]));

		const store = UnitStateStore.getInstance();
		assert.strictEqual(store.getEntry("en/handbook.md", 0), undefined, "訳文の行が取り残されないこと");
		assert.strictEqual(store.getEntry("en/guide.md", 0)?.need, "review");
		assert.ok(store.getEntry("ja/guide.md", 0), "原文の行も戻ること");
	});

	test("訳文だけを動かしたときは原文を動かさないこと（原文が正・訳文が従）", () => {
		place("ja/guide.md");
		place("en/guide.md");

		const edit = buildRenameFollowEdit(uris(["en/guide.md", "en/handbook.md"])) as unknown as RecordedEdit;

		assert.deepStrictEqual(edit.renamedFiles, []);
		assert.ok(fs.existsSync(abs("ja/guide.md")), "原文はその場に残ること");
	});

	test("フォルダごとの移動で、配下の行がまとめて追随すること", async () => {
		// イベントは1件しか来ない。ファイル単位に割り戻していると全部取りこぼす
		place("ja/sub/a.md");
		place("en/sub/a.md");
		place("en/sub/deep/b.md");
		seedEntry("en/sub/a.md", "review");
		seedEntry("en/sub/deep/b.md", "translate");

		const files = uris(["ja/sub", "ja/moved"]);
		const edit = buildRenameFollowEdit(files) as unknown as RecordedEdit;
		assert.strictEqual(edit.renamedFiles[0]?.newUri.fsPath, abs("en/moved"));

		moveOnDisk("ja/sub", "ja/moved");
		moveOnDisk("en/sub", "en/moved");
		await completeRenameFollow(files);

		const store = UnitStateStore.getInstance();
		assert.strictEqual(store.getEntry("en/moved/a.md", 0)?.need, "review");
		assert.strictEqual(store.getEntry("en/moved/deep/b.md", 0)?.need, "translate");
	});

	test("ピボット構成（ja→en, en→fr）で、連鎖する訳文まで連れて動かすこと", async () => {
		// en/x.md で止めると fr/x.md だけが取り残され、追随したせいで新しい孤立が生まれる
		Configuration.dispose();
		await initConfig([
			{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" },
			{ sourceDir: "en", targetDir: "fr", sourceLang: "en", targetLang: "fr" },
		]);
		place("ja/guide.md");
		place("en/guide.md");
		place("fr/guide.md");

		const edit = buildRenameFollowEdit(uris(["ja/guide.md", "ja/handbook.md"])) as unknown as RecordedEdit;

		assert.deepStrictEqual(
			edit.renamedFiles.map((r) => r.newUri.fsPath),
			[abs("en/handbook.md"), abs("fr/handbook.md")],
		);
	});
});
