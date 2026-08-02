"use strict";
/*
 * 頑健性プローブ（調査用・CI 非対象）。
 *
 * 「原文編集 / 訳文編集 / 章の挿入・削除 / リネーム / フォルダ移動 / ファイル削除 / 外部変更」を
 * embedded と external の両モードで同一手順で実行し、sync 後の状態を突き合わせる。
 *
 * S0〜S14 は単一操作。S20〜 は複合・意地悪シナリオ（分割/統合、見出しレベル変更、同一本文の重複章、
 * 原文と訳文の同時編集、構造の食い違い、2段階操作、先頭ユニット、冪等性、frontmatter）。
 *
 * 使い方: npm run compile && node scripts/exploratory/probe-robustness.js
 *
 * 注意: テストワークスペース（src/test/unit/workspace）の content と .mdait を破壊的に書き換える。
 * 終了時に copy-test-files で自動復元する（PROBE_KEEP=1 で復元を止めて最終状態を覗ける）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { vscode, REPO, WS } = require("./vscode-shim");
const { install: installFakeAi } = require("./fake-ai");

const origLog = console.log;
console.log = (...a) => {
	const s = String(a[0] != null ? a[0] : "");
	if (s.startsWith("StatusManager:") || s.startsWith("DefaultAIProvider")) return;
	origLog(...a);
};

const CONTENT = path.join(WS, "content");
const CFG_PATH = path.join(WS, ".mdait/mdait.json");
const MDAIT = path.join(WS, ".mdait");

const { syncCommand } = require(path.join(REPO, "out/commands/sync/sync-command.js"));
const { transCommand } = require(path.join(REPO, "out/commands/trans/trans-command.js"));
const { markdownParser } = require(path.join(REPO, "out/core/markdown/parser.js"));
const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
const { resolveMarkerIOForFile } = require(path.join(REPO, "out/infra/config/marker-io.js"));
const { UnitStateStore } = require(path.join(REPO, "out/core/unit-state/unit-state-store.js"));
const { UnitRegistryManager } = require(path.join(REPO, "out/core/unit-registry/unit-registry-manager.js"));
const { StatusManager } = require(path.join(REPO, "out/core/status/status-manager.js"));

/** dir 配下を再帰走査し、dir からの相対パス（/区切り）を返す（run-sweep.js の walk に揃える） */
function walkRelative(dir, base = dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walkRelative(full, base, out);
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out;
}
function rmrf(p) {
	if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function write(rel, text) {
	const p = path.join(CONTENT, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
}
function read(rel) {
	const p = path.join(CONTENT, rel);
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
function unitState() {
	const p = path.join(MDAIT, "unit-state");
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
function unitStateRows() {
	return unitState()
		.split("\n")
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => l.split("\t"));
}

async function setMode(mode, pairs) {
	const j = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
	j.ai = Object.assign({}, j.ai, { provider: "default", vendor: "default" });
	if (mode === "external") j.markers = { mode: "external" };
	else j.markers = undefined;
	if (pairs) j.transPairs = pairs;
	fs.writeFileSync(CFG_PATH, JSON.stringify(j, null, 2));
	await Configuration.getInstance().load();
	const { SelectionState } = require(path.join(REPO, "out/core/status/selection-state.js"));
	const sel = SelectionState.getInstance();
	sel.updateSelection(sel.getSelectableTargets().map((t) => t.key));
}

function resetAll() {
	rmrf(CONTENT);
	fs.mkdirSync(CONTENT, { recursive: true });
	for (const name of ["unit-state", "unit-registry", "reports"]) rmrf(path.join(MDAIT, name));
	UnitRegistryManager.resetInstance();
	UnitStateStore.dispose();
	if (StatusManager.dispose) StatusManager.dispose();
}

/**
 * テストワークスペース（content と .mdait の生成物）を元に戻す。
 * 本プローブは content を作り直し unit-state を書き換えるため、終了時に必ず復元する。
 * 最終状態を手で覗きたいときは PROBE_KEEP=1 で復元を止められる。
 */
function restoreWorkspace() {
	if (process.env.PROBE_KEEP) {
		origLog("\n（PROBE_KEEP=1 のためテストワークスペースを復元していません。`npm run copy-test-files` で戻せます）");
		return;
	}
	try {
		execSync("npm run copy-test-files", { cwd: REPO, stdio: "ignore" });
		for (const name of ["unit-state", "unit-registry"]) rmrf(path.join(MDAIT, name));
	} catch (e) {
		origLog(`  workspace restore failed: ${e && e.message}`);
	}
}

/** 対象ファイルのユニット一覧を「モードに依らない形」で読む */
function unitsOf(rel) {
	const abs = path.join(CONTENT, rel);
	if (!fs.existsSync(abs)) return null;
	const config = Configuration.getInstance();
	const io = resolveMarkerIOForFile(config, abs);
	const doc = markdownParser.parse(fs.readFileSync(abs, "utf8"), config, io.provider, io.ctx);
	return doc.units.map((u) => ({
		title: u.title || "(no title)",
		need: (u.marker && u.marker.need) || "",
		hash: (u.marker && u.marker.hash) || "",
		from: (u.marker && u.marker.from) || "",
		body: u.content.replace(/\s+/g, " ").trim().slice(0, 40),
	}));
}

/**
 * frontmatter マーカー（`mdait: front:` 行）の中身を返す。無ければ null。
 * frontmatter マーカーは external でもファイル側（frontmatter 内）に残るため、本文ユニットとは別に見る。
 */
function frontMarker(rel) {
	const abs = path.join(CONTENT, rel);
	if (!fs.existsSync(abs)) return null;
	const lines = fs.readFileSync(abs, "utf8").split("\n");
	if (lines[0] !== "---") return null;
	for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
		const m = /^\s+front:\s*(.*)$/.exec(lines[i]);
		if (m) return m[1].trim().replace(/^'|'$/g, "");
	}
	return null;
}

function fmtUnits(rel) {
	const us = unitsOf(rel);
	if (!us) return `${rel}: (ファイル無し)`;
	const fm = frontMarker(rel);
	const lines = us.map(
		(u, i) => `    [${i}] ${u.title.padEnd(14)} need=${(u.need || "-").padEnd(18)} hash=${u.hash || "--------"} from=${u.from || "--------"} | ${u.body}`,
	);
	if (fm) lines.unshift(`    [fm] frontmatter        ${fm}`);
	return `${rel}:\n${lines.join("\n")}`;
}

/**
 * 見出し行を先頭とする「章ブロック」の行範囲を返す。
 * embedded では見出し直前のマーカー行もブロックに含める（人が章ごと切り貼りする実態に合わせる）。
 */
function blockRange(lines, heading) {
	const h = lines.findIndex((l) => l.trim() === heading);
	if (h < 0) return null;
	let start = h;
	if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
	let end = lines.length;
	for (let i = h + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i]) || /^<!--\s*mdait\b/.test(lines[i].trim())) {
			end = /^<!--\s*mdait\b/.test(lines[i].trim()) ? i : i;
			break;
		}
	}
	return [start, end];
}
/** 章ブロックを丸ごと削除する */
function removeChapter(rel, heading) {
	const lines = read(rel).split("\n");
	const r = blockRange(lines, heading);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	lines.splice(r[0], r[1] - r[0]);
	write(rel, lines.join("\n"));
}
/** 指定見出しのブロックの直前に、マーカー無しの新しい章を挿入する */
function insertChapterBefore(rel, heading, block) {
	const lines = read(rel).split("\n");
	const r = blockRange(lines, heading);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	lines.splice(r[0], 0, ...block.split("\n"));
	write(rel, lines.join("\n"));
}
/** 2つの章ブロックを入れ替える */
function swapChapters(rel, headingA, headingB) {
	const lines = read(rel).split("\n");
	const a = blockRange(lines, headingA);
	const b = blockRange(lines, headingB);
	if (!a || !b || a[1] > b[0]) throw new Error("swap: 想定外のブロック順");
	const A = lines.slice(a[0], a[1]);
	const mid = lines.slice(a[1], b[0]);
	const B = lines.slice(b[0], b[1]);
	const rest = lines.slice(b[1]);
	write(rel, [...lines.slice(0, a[0]), ...B, ...mid, ...A, ...rest].join("\n"));
}
/** 本文の一部を置換する（マーカーは触らない＝実際の編集に近い） */
function editBody(rel, from, to) {
	const t = read(rel);
	if (!t.includes(from)) throw new Error(`body not found: ${from}`);
	write(rel, t.replace(from, to));
}
/**
 * 章ブロックの見出し行（と embedded のマーカー行）を落として本文だけ残す＝直前の章へ統合する。
 * 人が「章立てをやめて前の章に吸収した」操作に相当する。
 */
function mergeChapterIntoPrevious(rel, heading) {
	const lines = read(rel).split("\n");
	const r = blockRange(lines, heading);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	const kept = lines.slice(r[0], r[1]).filter((l) => l.trim() !== heading && !/^<!--\s*mdait\b/.test(l.trim()));
	lines.splice(r[0], r[1] - r[0], ...kept);
	write(rel, lines.join("\n"));
}
/** 見出し行のレベルだけを変える（本文・マーカーは触らない） */
function changeHeadingLevel(rel, heading, newHeading) {
	const lines = read(rel).split("\n");
	const h = lines.findIndex((l) => l.trim() === heading);
	if (h < 0) throw new Error(`chapter not found: ${heading}`);
	lines[h] = newHeading;
	write(rel, lines.join("\n"));
}

const SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 第1章",
	"",
	"第1章の本文。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
	"## 第3章",
	"",
	"第3章の本文。",
	"",
].join("\n");

/** コピペで作られた同一本文の章を2つ持つ原文（S24/S25 用） */
const DUP_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
	"## 第3章",
	"",
	"第3章の本文。",
	"",
].join("\n");

/** frontmatter を持つ原文（S33/S34 用。frontmatter マーカーは現状どちらのモードでも本文側に残る） */
const FM_SRC = ["---", 'title: "ガイド"', 'description: "ガイドの説明"', "---", "", ...SRC.split("\n")].join("\n");

/** 初期状態: 原文を置き → sync → trans（フェイク）→ sync（need クリア） */
async function bootstrap(mode, src) {
	const t = (label, p) => {
		const s = Date.now();
		return Promise.resolve(p()).then((r) => {
			if (process.env.PROBE_TIME) origLog(`    ${label}: ${Date.now() - s}ms`);
			return r;
		});
	};
	resetAll();
	write("ja/guide.md", src || SRC);
	await t("setMode", () => setMode(mode));
	await t("sync1", () => syncCommand());
	installFakeAi();
	const tgt = path.join(CONTENT, "en/guide.md");
	if (fs.existsSync(tgt)) await t("trans", () => transCommand(vscode.Uri.file(tgt)));
	await t("sync2", () => syncCommand());
}

const results = [];
const ONLY = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",") : null;
async function scenario(name, mutate, opts) {
	// 先頭トークン（S3 など）で厳密一致。S3 と S30 が衝突しないよう前方一致にはしない
	if (ONLY && !ONLY.includes(name.split(" ")[0])) return;
	for (const mode of ["embedded", "external"]) {
		await bootstrap(mode, opts && opts.src);
		const before = { src: unitsOf("ja/guide.md"), tgt: unitsOf("en/guide.md"), us: unitState() };
		try {
			await mutate(mode);
		} catch (e) {
			origLog(`  mutate error: ${e && e.message}`);
		}
		if (opts && opts.reloadConfig) await setMode(mode, opts.pairs);
		await syncCommand();
		// 冪等性の確認用: 何も変えずに sync を追加で回す
		for (let i = 0; i < ((opts && opts.extraSyncs) || 0); i++) await syncCommand();
		if (opts && opts.transAfter) {
			installFakeAi();
			for (const rel of opts.transAfter) {
				const abs = path.join(CONTENT, rel);
				if (fs.existsSync(abs)) {
					try {
						await transCommand(vscode.Uri.file(abs));
					} catch (e) {
						origLog(`  trans error: ${e && e.message}`);
					}
				}
			}
			await syncCommand();
		}
		const after = {
			files: walkRelative(CONTENT)
				.filter((f) => f.endsWith(".md"))
				.sort(),
			us: unitState(),
		};
		results.push({ name, mode, before, after, dump: opts && opts.dump ? opts.dump() : null });
		origLog(`\n===== ${name} / ${mode} =====`);
		origLog(`  files: ${after.files.join(", ")}`);
		for (const f of after.files) origLog(`  ${fmtUnits(f).split("\n").join("\n  ")}`);
		if (mode === "external") origLog(`  --- unit-state ---\n${after.us.replace(/^/gm, "  ")}`);
	}
}

async function main() {
	const cfgBackup = fs.readFileSync(CFG_PATH);
	try {
		// S0: 基準（何もしない）
		await scenario("S0 何もしない（基準）", async () => {});

		// S1: 原文の1章だけ本文編集
		await scenario("S1 原文の第2章を編集", async () => {
			editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
		});

		// S2: 訳文だけ編集（人手修正）
		await scenario("S2 訳文の第2章を人手編集", async () => {
			editBody("en/guide.md", "第2章の本文。 [MT]", "Chapter 2 (hand-edited)");
		});

		// S3: 章の挿入（中間に新章）
		await scenario("S3 原文の第1章と第2章の間に新章を挿入", async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		});

		// S4: 章の削除（中間の章を削除）
		await scenario("S4 原文の第2章を削除", async () => {
			removeChapter("ja/guide.md", "## 第2章");
		});

		// S5: 章の並べ替え
		await scenario("S5 原文の第2章と第3章を入れ替え", async () => {
			swapChapters("ja/guide.md", "## 第2章", "## 第3章");
		});

		// S6: 原文ファイルのリネーム（訳文はそのまま）
		await scenario("S6 原文をリネーム（guide.md → handbook.md）", async () => {
			fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
		});

		// S7: 原文・訳文を揃えてリネーム
		await scenario("S7 原文・訳文を揃えてリネーム", async () => {
			fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
			fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/handbook.md"));
		});

		// S8: フォルダ移動（原文・訳文とも sub/ 配下へ）
		await scenario("S8 原文・訳文をサブフォルダへ移動", async () => {
			fs.mkdirSync(path.join(CONTENT, "ja/sub"), { recursive: true });
			fs.mkdirSync(path.join(CONTENT, "en/sub"), { recursive: true });
			fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/sub/guide.md"));
			fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/sub/guide.md"));
		});

		// S9: 原文ファイルの削除
		await scenario("S9 原文ファイルを削除", async () => {
			fs.rmSync(path.join(CONTENT, "ja/guide.md"));
		});

		// S10: 混合（章挿入 ＋ 本文編集 ＋ リネーム）
		await scenario("S10 混合（章挿入＋編集＋原文/訳文リネーム）", async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			editBody("ja/guide.md", "第3章の本文。", "第3章の本文（改訂）。");
			fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
			fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/handbook.md"));
		});

		// S11: 外部変更（unit-state を消す = git conflict 解決で捨てた / 別マシンで未生成）
		await scenario("S11 外部変更: unit-state を削除", async () => {
			rmrf(path.join(MDAIT, "unit-state"));
			UnitStateStore.dispose();
		});

		// S12: 外部変更（訳文ファイルだけ手で全置換＝マーカーごと消える）
		await scenario("S12 外部変更: 訳文からマーカーが消えた状態で戻ってくる", async () => {
			write("en/guide.md", ["# Document", "", "Intro.", "", "## Chapter 1", "", "Body 1.", "", "## Chapter 2", "", "Body 2.", "", "## Chapter 3", "", "Body 3.", ""].join("\n"));
		});
		// S14: 訳文ファイルだけ削除（やり直したいときの典型操作）
		await scenario("S14 訳文ファイルを削除", async () => {
			fs.rmSync(path.join(CONTENT, "en/guide.md"));
		});

		// S13: 章挿入のあと trans まで走らせる（誤対応が訳文本文に及ぶかを見る）
		await scenario(
			"S13 章挿入 → sync → trans（誤対応の実害）",
			async () => {
				insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			},
			{ transAfter: ["en/guide.md"] },
		);

		// ---- S20〜: 複合・意地悪シナリオ ----

		// S20: 章の分割（1章を2章に割る）＝ 編集＋挿入の合わせ技
		await scenario("S20 原文の第2章を2つに分割", async () => {
			editBody("ja/guide.md", "第2章の本文。", "第2章の本文（前半）。\n\n## 第2.5章\n\n第2章の本文（後半）。");
		});

		// S21: 章の統合（第3章の見出しを外して第2章に吸収）＝ 編集＋削除の合わせ技
		await scenario("S21 原文の第3章を第2章に統合", async () => {
			mergeChapterIntoPrevious("ja/guide.md", "## 第3章");
		});

		// S22: 見出しレベルを下げる（## → ###）。ユニット数は変わらず level だけ変わる
		await scenario("S22 原文の第2章を ## から ### へ降格", async () => {
			changeHeadingLevel("ja/guide.md", "## 第2章", "### 第2章");
		});

		// S23: 降格して sync したあと元に戻して sync（2段階・自己修復するか）
		await scenario("S23 第2章を ### に降格→sync→## に戻す（2段階）", async () => {
			changeHeadingLevel("ja/guide.md", "## 第2章", "### 第2章");
			await syncCommand();
			changeHeadingLevel("ja/guide.md", "### 第2章", "## 第2章");
		});

		// S24: 同一本文の章が2つある文書（コピペ章）の間に新章を挿入
		await scenario(
			"S24 同一本文の章が2つある文書へ章を挿入",
			async () => {
				insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			},
			{ src: DUP_SRC },
		);

		// S25: 同一本文の章が2つある文書から、先に出てくる方を削除
		await scenario(
			"S25 同一本文の章のうち先頭側を削除",
			async () => {
				removeChapter("ja/guide.md", "## 注意事項");
			},
			{ src: DUP_SRC },
		);

		// S26: 原文で章を挿入しつつ、訳文の別の章を人手で直す（両側同時編集）
		await scenario("S26 原文へ章挿入＋訳文の別章を人手編集", async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			editBody("en/guide.md", "第3章の本文。 [MT]", "Chapter 3 (hand-edited)");
		});

		// S27: 原文で章を挿入し、訳文では別の章を削除（双方の構造が食い違う）
		await scenario("S27 原文へ章挿入＋訳文の第2章を削除", async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			removeChapter("en/guide.md", "## 第2章 第2章の本文。 [MT]");
		});

		// S28: 並べ替えとフォルダ移動を同時に行う
		await scenario("S28 章の入れ替え＋原文/訳文をサブフォルダへ移動", async () => {
			swapChapters("ja/guide.md", "## 第2章", "## 第3章");
			fs.mkdirSync(path.join(CONTENT, "ja/sub"), { recursive: true });
			fs.mkdirSync(path.join(CONTENT, "en/sub"), { recursive: true });
			fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/sub/guide.md"));
			fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/sub/guide.md"));
		});

		// S29: 挿入して sync → さらに別の章を削除して sync（壊れの上に操作を重ねる）
		await scenario("S29 章挿入→sync→第3章を削除→sync（2段階）", async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			await syncCommand();
			removeChapter("ja/guide.md", "## 第3章");
		});

		// S30: 先頭ユニット（H1 の導入）を削除する
		await scenario("S30 先頭ユニット（導入 H1）を削除", async () => {
			removeChapter("ja/guide.md", "# ドキュメント");
		});

		// S31: 文書の先頭に新しい H1 を挿入する（全ユニットが1つずれる）
		await scenario("S31 文書の先頭に新しい H1 を挿入", async () => {
			insertChapterBefore("ja/guide.md", "# ドキュメント", "# 新しいタイトル\n\n新しい導入。\n");
		});

		// S32: 壊れた状態で sync を繰り返す（増殖・振動しないか＝冪等性）
		await scenario(
			"S32 章挿入→sync を3回繰り返す（冪等性）",
			async () => {
				insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			},
			{ extraSyncs: 2 },
		);

		// S33: frontmatter を持つ文書の途中に章を挿入
		await scenario(
			"S33 frontmatter 付き文書へ章を挿入",
			async () => {
				insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
			},
			{ src: FM_SRC },
		);

		// S34: frontmatter を持つ文書で frontmatter を編集しつつ章を削除
		await scenario(
			"S34 frontmatter 編集＋章削除",
			async () => {
				editBody("ja/guide.md", 'title: "ガイド"', 'title: "ガイド（改訂）"');
				removeChapter("ja/guide.md", "## 第2章");
			},
			{ src: FM_SRC },
		);
	} finally {
		fs.writeFileSync(CFG_PATH, cfgBackup);
		restoreWorkspace();
	}
	origLog("\n========== DONE ==========");
	// 保留中のタイマー/ウォッチャで終了しないため明示的に落とす
	process.exit(0);
}

main().catch((e) => {
	origLog("PROBE ERROR:", (e && e.stack) || e);
	process.exit(1);
});
