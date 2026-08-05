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
/**
 * 同じ見出しが何度も出てくる文書のために、n 番目（0始まり）の出現に対する章ブロック範囲を返す。
 * blockRange と同じ規則（embedded では直前のマーカー行も含める）。
 */
function blockRangeNth(lines, heading, n) {
	let seen = -1;
	let h = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === heading) {
			seen++;
			if (seen === n) {
				h = i;
				break;
			}
		}
	}
	if (h < 0) return null;
	let start = h;
	if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
	let end = lines.length;
	for (let i = h + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i]) || /^<!--\s*mdait\b/.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	return [start, end];
}
/** n 番目（0始まり）の同名見出しの章ブロックを丸ごと削除する */
function removeChapterNth(rel, heading, n) {
	const lines = read(rel).split("\n");
	const r = blockRangeNth(lines, heading, n);
	if (!r) throw new Error(`chapter not found: ${heading}#${n}`);
	lines.splice(r[0], r[1] - r[0]);
	write(rel, lines.join("\n"));
}
/** n 番目（0始まり）の同名見出しの章ブロックの直前に新しい章を挿入する */
function insertChapterBeforeNth(rel, heading, n, block) {
	const lines = read(rel).split("\n");
	const r = blockRangeNth(lines, heading, n);
	if (!r) throw new Error(`chapter not found: ${heading}#${n}`);
	lines.splice(r[0], 0, ...block.split("\n"));
	write(rel, lines.join("\n"));
}
/** 章ブロックを丸ごと文書末尾へ移す（embedded ではマーカーごと動く＝人が切り貼りした形） */
function moveChapterToEnd(rel, heading) {
	const lines = read(rel).split("\n");
	const r = blockRangeNth(lines, heading, 0);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	const block = lines.slice(r[0], r[1]);
	lines.splice(r[0], r[1] - r[0]);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	write(rel, [...lines, "", ...block].join("\n"));
}
/**
 * 末尾から n 個の `## ` 章ブロックを削除する（embedded では直前のマーカー行も落とす）。
 * 「章をまとめて大きく減らした」操作をモードに依らず作るために使う。
 */
function removeLastChapters(rel, n) {
	const lines = read(rel).split("\n");
	for (let k = 0; k < n; k++) {
		let h = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^##\s/.test(lines[i])) {
				h = i;
				break;
			}
		}
		if (h < 0) throw new Error(`no chapter left in ${rel}`);
		let start = h;
		if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
		lines.splice(start, lines.length - start);
	}
	write(rel, `${lines.join("\n")}\n`);
}
/** 文書の末尾へ新しい章を足す（マーカー無し＝人が書き足した形） */
function appendChapter(rel, heading, body) {
	write(rel, `${read(rel).replace(/\s*$/, "\n")}\n${heading}\n\n${body}\n`);
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

/** 同じディレクトリに置くもう1本の原文（S9 用。ディレクトリが空にならないようにする） */
const OTHER_SRC = ["# もう一つの文書", "", "こちらの導入。", "", "## 付録", "", "付録の本文。", ""].join("\n");

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

// ---- S40〜 用の「病的な文書」たち ----

/** まったく同じ本文の章が3つある原文（S40〜S42） */
const TRIPLE_SRC = [
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
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
].join("\n");

/** 本文が空の章（見出しだけの章）が並ぶ原文。うち2つは見出しまで同一（S43・S44） */
const HEADONLY_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 用語",
	"",
	"## 記法",
	"",
	"## 予約",
	"",
	"## 予約",
	"",
	"## まとめ",
	"",
	"まとめの本文。",
	"",
].join("\n");

/** 同じ見出しがレベル違いで同居する原文（S45・S46） */
const LEVEL_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 概要",
	"",
	"概要の本文。",
	"",
	"### 概要",
	"",
	"詳細な概要の本文。",
	"",
	"## 手順",
	"",
	"手順の本文。",
	"",
	"### 概要",
	"",
	"もうひとつの詳細。",
	"",
].join("\n");

/** 見出しに属さない前書きから始まる原文（S47・S48） */
const PREAMBLE_SRC = [
	"前書きの文章。どの見出しにも属さない。",
	"",
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
].join("\n");

/** ユニットが1つしかない原文（S52・S53） */
const SINGLE_SRC = ["# ただ一つの章", "", "唯一の本文。", ""].join("\n");

/** 20 章を持つ原文（S54） */
const MANY_SRC = ["# 手引き", "", "導入の文章。", ""]
	.concat(
		Array.from({ length: 20 }, (_, i) => [`## 第${i + 1}節`, "", `第${i + 1}節の本文。`, ""]).reduce((a, b) => a.concat(b), []),
	)
	.join("\n");

/** コードブロックの中に mdait マーカーらしき文字列がある原文（design.md P9・S55） */
const CODE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"マーカーの書き方は次のとおりです。",
	"",
	"```markdown",
	"<!-- mdait 12345678 from:87654321 need:translate -->",
	"## サンプル章",
	"",
	"サンプルの本文。",
	"```",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

/**
 * 既定の翻訳ペア（ja → en の1本）。
 * シナリオが `pairs` で別の組を指定できるようにしたため、指定が無いときは必ずここへ戻す
 * （前のシナリオが書き換えた mdait.json を次のシナリオが引き継がないようにするため）。
 */
const DEFAULT_PAIRS = [{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" }];

/** 同じディレクトリを "./" 付きで書いたペア（表記ゆれのシナリオ用） */
const DOTTED_PAIRS = [
	{ sourceLang: "ja", sourceDir: "./content/ja", targetLang: "en", targetDir: "./content/en" },
];

/** 訳文2言語（ja → en, ja → fr）。多言語構成のシナリオ用 */
const MULTI_PAIRS = [
	{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" },
	{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "fr", targetDir: "content/fr" },
];

/** 対象言語の選択を差し替える（sync が走査するペアを絞る） */
function selectTargets(keys) {
	const { SelectionState } = require(path.join(REPO, "out/core/status/selection-state.js"));
	SelectionState.getInstance().updateSelection(keys);
}

/** コードブロックを `~~~` で囲んだ原文（S72。```` ``` ```` 限定の実装だと素通りする） */
const TILDE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"マーカーの書き方は次のとおりです。",
	"",
	"~~~markdown",
	"<!-- mdait 12345678 from:87654321 need:translate -->",
	"## サンプル章",
	"",
	"サンプルの本文。",
	"~~~",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

/** リストと引用の中にコードブロックがある原文（S73。行頭の字下げ・引用記号を落とさないか） */
const NESTED_CODE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 手順",
	"",
	"- 手順1: 実行する",
	"  ```js",
	"  console.log(1);",
	"  ```",
	"- 手順2: 確認する",
	"",
	"## 注意",
	"",
	"> 次のように書く。",
	"> ```js",
	"> console.log(2);",
	"> ```",
	"",
].join("\n");

/**
 * 字下げ（4スペース）コードブロックにマーカー風文字列がある原文（S74）。
 * マーカー風の行は**ブロックの2行目以降**に置く。直前が空行だと
 * 「マーカーの前に空行を入れる」処理が発火せず、欠陥を再現できないため。
 */
const INDENTED_CODE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"字下げで書いた例。",
	"",
	"    ## サンプル章",
	"    <!-- mdait 12345678 from:87654321 need:translate -->",
	"    サンプルの本文。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

/**
 * 「この行の並びが、順序も含めてそのまま残っていること」を確かめる絶対チェックを作る。
 * 両モードが揃って壊れる欠陥は突き合わせでは出ないので、結果そのものを見るしかない。
 *
 * 各行が「どこかに在るか」だけを見ると、行の間に何かが挿し込まれても通ってしまう。
 * パーサーがコードブロックの中へ空行を入れる欠陥（B-2）はまさにその形なので、
 * **連続一致**で見る。
 */
function expectLinesIntact(rel, lines) {
	return ({ read }) => {
		const content = read(rel);
		if (content === null) return [`${rel} が存在しない`];
		const block = lines.join("\n");
		if (content.includes(block)) return [];
		// どこで崩れたかを分かりやすく出す（行が消えたのか、間に何か入ったのか）
		const actual = content.split("\n");
		const missing = lines.filter((l) => !actual.includes(l));
		if (missing.length > 0) {
			return missing.map((l) => `${rel} に行が残っていない: ${JSON.stringify(l)}`);
		}
		return [`${rel} で行の並びが崩れている（各行は在るが連続していない）: ${JSON.stringify(block)}`];
	};
}

/** 「この行が在ること」を確かめる（消えていないか）。順序は問わない */
function expectLinesPresent(rel, lines) {
	return ({ read }) => {
		const content = read(rel);
		if (content === null) return [`${rel} が存在しない`];
		const actual = content.split("\n");
		return lines.filter((l) => !actual.includes(l)).map((l) => `${rel} に行が無い: ${JSON.stringify(l)}`);
	};
}

/** 初期状態: 原文を置き → sync → trans（フェイク）→ sync（need クリア） */
async function bootstrap(mode, src, pairs, extraSources) {
	const t = (label, p) => {
		const s = Date.now();
		return Promise.resolve(p()).then((r) => {
			if (process.env.PROBE_TIME) origLog(`    ${label}: ${Date.now() - s}ms`);
			return r;
		});
	};
	resetAll();
	write("ja/guide.md", src || SRC);
	// 原文をもう1本置くシナリオ用（「ディレクトリの中身の数で挙動が変わる」を測れるようにする）
	for (const [rel, text] of Object.entries(extraSources || {})) write(rel, text);
	await t("setMode", () => setMode(mode, pairs || DEFAULT_PAIRS));
	await t("sync1", () => syncCommand());
	installFakeAi();
	// 全ペアの訳文をすべて翻訳しておく（多言語シナリオの fr 側や、原文が複数あるときの2本目も）
	for (const p of pairs || DEFAULT_PAIRS) {
		const dir = path.join(WS, p.targetDir);
		if (!fs.existsSync(dir)) continue;
		for (const rel of walkRelative(dir)) {
			if (!rel.endsWith(".md")) continue;
			await t(`trans:${p.targetLang}:${rel}`, () => transCommand(vscode.Uri.file(path.join(dir, rel))));
		}
	}
	await t("sync2", () => syncCommand());
}

const results = [];
/**
 * 両モードの突き合わせでは見つからない壊れ方（＝両モードが同じように壊れる場合）を捕まえるための
 * 「絶対チェック」の失敗一覧。シナリオの opts.expect が返した文言を溜める。
 *
 * 突き合わせは相対的な検査なので、embedded と external が揃って壊れると差が出ず素通りする。
 * コードブロックの取り扱いのように「両モード共通の読み書き」に関わる欠陥はここでしか守れない。
 */
const absoluteFailures = [];
const ONLY = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",") : null;
async function scenario(name, mutate, opts) {
	// 先頭トークン（S3 など）で厳密一致。S3 と S30 が衝突しないよう前方一致にはしない
	if (ONLY && !ONLY.includes(name.split(" ")[0])) return;
	for (const mode of ["embedded", "external"]) {
		await bootstrap(mode, opts && opts.src, opts && opts.pairs, opts && opts.extraSources);
		const before = { src: unitsOf("ja/guide.md"), tgt: unitsOf("en/guide.md"), us: unitState() };
		try {
			// external でしか意味を持たない操作（モード切替・表記ゆれ）は embedded 側では何もしない。
			// embedded にとっての等価な操作が no-op だからで、突き合わせは「往復が無損失か」を見る
			if (!(opts && opts.externalOnly) || mode === "external") await mutate(mode);
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
		// 両モードの突き合わせに使う「文書の見え方」。unit-state の中身は
		// external にしか無いので比較には含めない（比べたいのは結果であって保管形式ではない）。
		const view = [`files: ${after.files.join(", ")}`, ...after.files.map((f) => fmtUnits(f))].join("\n");
		results.push({ name, mode, view });
		origLog(`\n===== ${name} / ${mode} =====`);
		origLog(`  files: ${after.files.join(", ")}`);
		for (const f of after.files) origLog(`  ${fmtUnits(f).split("\n").join("\n  ")}`);
		if (mode === "external") origLog(`  --- unit-state ---\n${after.us.replace(/^/gm, "  ")}`);
		// 絶対チェック（両モードが同じように壊れても気づけるように、結果そのものを見る）
		if (opts && opts.expect) {
			for (const msg of opts.expect({ read, mode }) || []) {
				absoluteFailures.push(`${name} / ${mode}: ${msg}`);
				origLog(`  [絶対チェック失敗] ${msg}`);
			}
		}
	}
}

/**
 * 両モードで結果が違ってよいシナリオと、その理由。
 * ここに無いシナリオで差が出たら、どちらかの入口だけが直った（または壊れた）ということ。
 */
const EXPECTED_DIFF = {
	S6: "ファイルの同一性（パス）の話。行の追随は未対応",
	S7: "同上",
	S8: "同上",
	S9: "原文を消すと external は訳文の状態を失う（embedded は本文にマーカーが残る）。ファイルの同一性の話で未対応。原文が1本だけのときは content/ja が0件になり『走査していない』扱いで行が残るため一致してしまう＝ディレクトリの中身の数で挙動が変わる。実態を測るため原文を2ファイルにしてある",
	S10: "リネームを含むため（章の挿入・編集の部分は一致している）",
	S11: "unit-state を消す操作なので embedded には影響が無い",
	S12: "本文からマーカーが消えても external は状態を保つ（external が強い。意図した差）",
	S28: "リネームを含むため（並べ替えの部分は一致している）",
	S50: "章を消したうえで残りを見出しごと全面改稿。どの章が消えたかを示す情報がファイルに残らない（外部ストア方式の構造的な限界）",
	S56: "同上（訳文側を全面改稿してから原文の章を削除）",
	S69: "フェンスに飲まれたユニットで差が出る。それ以外の章は両モードとも完全復帰する（自動削除の見送りが効いている）。external はそのユニットの訳を保って need:revise、embedded はマーカーがフェンスに飲まれて訳を失い原文で作り直す＝external が強い（S12 と同種）。実測では、フェンスを直すのと同時に章を1つ編集すると embedded はその章の訳も失う（原文側のマーカーも飲まれて from の指す hash が消えるため）。孤立1件は普通の編集の形なので自動削除の見送りは効かない",
};

/**
 * まだ直していない既知の欠陥。想定内の差とは分けて数え、毎回はっきり出す。
 * 直したらここから消すこと（消し忘れると差が出なくなったことに気づけない）。
 */
const KNOWN_BUGS = {
	S68: "訳文を空にして同じ内容を貼り戻すと external だけ全ユニットが need:translate に固定される。行が残っているため rebuild 検知（sync-command.ts の isExternalRebuild）が働かない。保留席とは無関係の既存欠陥",
};

/**
 * **両モードが同じように壊れている**ため突き合わせには出ない、未解決の欠陥。
 * 差が出ないので `KNOWN_BUGS` の仕組み（モード差の説明）には載せられないが、
 * 消し忘れに気づけるよう毎回はっきり出す。直したらここから消すこと。
 */
const KNOWN_BUGS_BOTH_MODES = {
	S71: "訳文を手編集してもハッシュが更新されるだけで、編集されたことがどのサーフェスにも出ない（need を付けるのは need の語彙とぶつかるため製品判断待ち。unit-state.md §15 参照）",
};

/** シナリオごとに embedded と external の結果を突き合わせる */
function reportModeParity() {
	const byName = new Map();
	for (const r of results) {
		if (!byName.has(r.name)) byName.set(r.name, {});
		byName.get(r.name)[r.mode] = r.view;
	}
	const unexpected = [];
	let same = 0;
	let expectedDiff = 0;
	let knownBugs = 0;
	origLog("\n========== embedded と external の突き合わせ ==========");
	for (const [name, v] of byName) {
		if (v.embedded === undefined || v.external === undefined) continue;
		const key = name.split(" ")[0];
		if (v.embedded === v.external) {
			same++;
			if (EXPECTED_DIFF[key] || KNOWN_BUGS[key]) {
				origLog(`  [注意] ${name}: 差が出る想定だったが一致した（一覧の見直しどき）`);
			}
		} else if (KNOWN_BUGS[key]) {
			knownBugs++;
			origLog(`  [未修正の既知欠陥] ${name} — ${KNOWN_BUGS[key]}`);
		} else if (EXPECTED_DIFF[key]) {
			expectedDiff++;
			origLog(`  [想定内の差] ${name} — ${EXPECTED_DIFF[key]}`);
		} else {
			unexpected.push(name);
			origLog(`  [不一致] ${name}`);
		}
	}
	origLog(
		`\n一致 ${same} / 想定内の差 ${expectedDiff} / 未修正の既知欠陥 ${knownBugs} / 想定外の差 ${unexpected.length}`,
	);

	// 突き合わせは相対的な検査なので、両モードが揃って壊れると差が出ない。
	// 結果そのものを見る絶対チェックの失敗はここで別に数える。
	const bothModes = Object.entries(KNOWN_BUGS_BOTH_MODES).filter(([key]) =>
		[...byName.keys()].some((n) => n.split(" ")[0] === key),
	);
	if (bothModes.length > 0) {
		origLog("\n========== 両モード共通の未修正欠陥（差が出ないので突き合わせでは検出できない） ==========");
		for (const [key, reason] of bothModes) origLog(`  [未修正] ${key} — ${reason}`);
	}

	origLog("\n========== 絶対チェック（両モード共通の壊れ方） ==========");
	if (absoluteFailures.length === 0) {
		origLog("  すべて通過");
	} else {
		for (const m of absoluteFailures) origLog(`  [失敗] ${m}`);
	}
	origLog(`\n絶対チェックの失敗 ${absoluteFailures.length}`);

	return unexpected.length + absoluteFailures.length;
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

		// S9: 原文ファイルの削除。原文をもう1本置いてから片方だけ消す。
		//     原文が1本しか無いと content/ja が0件になり「走査していない」扱いで行が残るため、
		//     ディレクトリに他のファイルが在る実態（＝ふつうのサイト）を測る。
		await scenario(
			"S9 原文ファイルを削除（原文は2ファイル）",
			async () => {
				fs.rmSync(path.join(CONTENT, "ja/guide.md"));
			},
			{ extraSources: { "ja/other.md": OTHER_SRC } },
		);

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

		// S35: frontmatter 付き文書で訳文を捨てて sync で作り直し、同じセッションのまま trans する
		//      （同一内容の再パースで gray-matter のキャッシュに当たるか＝S14 の frontmatter 版）
		await scenario(
			"S35 frontmatter 付き訳文を削除→sync で作り直し→trans",
			async () => {
				fs.rmSync(path.join(CONTENT, "en/guide.md"));
			},
			{ src: FM_SRC, transAfter: ["en/guide.md"] },
		);

		// ---- S40〜: 内容照合アルゴリズムが苦手そうな「病的な文書」 ----

		// S40: 同一本文の章が3つ。真ん中を消すと、残り2つのどちらが消えたか本文からは決まらない
		await scenario(
			"S40 同一本文の章が3つ、真ん中を削除",
			async () => {
				removeChapterNth("ja/guide.md", "## 注意事項", 1);
			},
			{ src: TRIPLE_SRC },
		);

		// S41: 同一本文の章が3つ。2つ目と3つ目のあいだに新章を挿入
		await scenario(
			"S41 同一本文の章が3つ、2つ目と3つ目の間に新章を挿入",
			async () => {
				insertChapterBeforeNth("ja/guide.md", "## 注意事項", 2, "## 第2.5章\n\n第2.5章の本文。\n");
			},
			{ src: TRIPLE_SRC },
		);

		// S42: 同一本文の章が3つ。末尾側を削除しつつ、その手前の章を編集（錨がずれる）
		await scenario(
			"S42 同一本文の章が3つ、末尾を削除＋第2章を編集",
			async () => {
				removeChapterNth("ja/guide.md", "## 注意事項", 2);
				editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
			},
			{ src: TRIPLE_SRC },
		);

		// S43: 見出しだけの章が並ぶ文書から、中間の見出しだけの章を削除
		await scenario(
			"S43 見出しだけの章が並ぶ文書から中間を削除",
			async () => {
				removeChapter("ja/guide.md", "## 記法");
			},
			{ src: HEADONLY_SRC },
		);

		// S44: 見出しだけの章（うち2つは見出しまで同一）の2つ目の直前に、見出しだけの章を挿入
		await scenario(
			"S44 見出しだけ・同名の章の間に見出しだけの章を挿入",
			async () => {
				insertChapterBeforeNth("ja/guide.md", "## 予約", 1, "## 追加\n");
			},
			{ src: HEADONLY_SRC },
		);

		// S45: 同名見出しがレベル違いで同居する文書から、最初の「### 概要」を削除
		await scenario(
			"S45 同名見出し（レベル違い同居）の最初の ### 概要 を削除",
			async () => {
				removeChapterNth("ja/guide.md", "### 概要", 0);
			},
			{ src: LEVEL_SRC },
		);

		// S46: 「## 概要」を「### 概要」へ降格。見出しハッシュ＋レベルが他の章と衝突する
		await scenario(
			"S46 ## 概要 を ### へ降格（同名 ### が2つある文書）",
			async () => {
				changeHeadingLevel("ja/guide.md", "## 概要", "### 概要");
			},
			{ src: LEVEL_SRC },
		);

		// S47: 見出しに属さない前書きを編集する
		await scenario(
			"S47 見出しの無い前書きを編集",
			async () => {
				editBody("ja/guide.md", "前書きの文章。どの見出しにも属さない。", "前書きの文章（改訂）。どの見出しにも属さない。");
			},
			{ src: PREAMBLE_SRC },
		);

		// S48: 見出しに属さない前書きを丸ごと削除する（先頭ユニットが消える）
		await scenario(
			"S48 見出しの無い前書きを削除",
			async () => {
				const lines = read("ja/guide.md").split("\n");
				const h = lines.findIndex((l) => l.trim() === "# ドキュメント");
				let start = h;
				if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
				write("ja/guide.md", lines.slice(start).join("\n"));
			},
			{ src: PREAMBLE_SRC },
		);

		// S49: 全ユニットの見出しも本文も同時に書き換える（手がかりが1つも残らない）
		await scenario("S49 全ユニットの見出しと本文を同時に全面改稿", async () => {
			editBody("ja/guide.md", "# ドキュメント", "# 手引き");
			editBody("ja/guide.md", "導入の文章。", "はじめにお読みください。");
			editBody("ja/guide.md", "## 第1章", "## 概論");
			editBody("ja/guide.md", "第1章の本文。", "概論の中身。");
			editBody("ja/guide.md", "## 第2章", "## 各論");
			editBody("ja/guide.md", "第2章の本文。", "各論の中身。");
			editBody("ja/guide.md", "## 第3章", "## 結論");
			editBody("ja/guide.md", "第3章の本文。", "結論の中身。");
		});

		// S50: 第1章を削除しつつ、残る第2章・第3章を見出しごと全面改稿
		//      （どの章が消えたかを示す手がかりが本文に一切残らない）
		await scenario("S50 第1章を削除＋第2章・第3章を見出しごと全面改稿", async () => {
			removeChapter("ja/guide.md", "## 第1章");
			editBody("ja/guide.md", "## 第2章", "## 各論");
			editBody("ja/guide.md", "第2章の本文。", "各論の中身。");
			editBody("ja/guide.md", "## 第3章", "## 結論");
			editBody("ja/guide.md", "第3章の本文。", "結論の中身。");
		});

		// S51: 章を入れ替え、さらに移動した片方を編集（確定した対応が単調でなくなる）
		await scenario("S51 第2章と第3章を入れ替え＋第3章を編集", async () => {
			swapChapters("ja/guide.md", "## 第2章", "## 第3章");
			editBody("ja/guide.md", "第3章の本文。", "第3章の本文（改訂）。");
		});

		// S52: ユニットが1つしかない文書の本文を編集
		await scenario(
			"S52 ユニットが1つだけの文書を編集",
			async () => {
				editBody("ja/guide.md", "唯一の本文。", "唯一の本文（改訂）。");
			},
			{ src: SINGLE_SRC },
		);

		// S53: ユニットが1つしかない文書を空にする（ユニット0件＝行の刈り取りが止まる境界）
		await scenario(
			"S53 ユニットが1つだけの文書を空にする",
			async () => {
				write("ja/guide.md", "");
			},
			{ src: SINGLE_SRC },
		);

		// S54: 20 章の文書に、挿入・削除・削除・編集を同時に加える
		await scenario(
			"S54 20章の文書へ複数箇所の挿入・削除・編集",
			async () => {
				insertChapterBefore("ja/guide.md", "## 第5節", "## 第4.5節\n\n第4.5節の本文。\n");
				removeChapter("ja/guide.md", "## 第10節");
				removeChapter("ja/guide.md", "## 第15節");
				editBody("ja/guide.md", "第18節の本文。", "第18節の本文（改訂）。");
			},
			{ src: MANY_SRC },
		);

		// S55: コードブロックの中にマーカーらしき文字列がある文書へ章を挿入し、別の章を編集
		await scenario(
			"S55 コードブロック内にマーカー風文字列がある文書へ章挿入＋編集",
			async () => {
				insertChapterBefore("ja/guide.md", "## コード例", "## 前置き\n\n前置きの本文。\n");
				editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
			},
			{ src: CODE_SRC },
		);

		// S56: 訳文側だけを大きく編集（章削除＋見出しごと改稿）してから、原文の構造も変える
		await scenario("S56 訳文を大幅改稿（章削除＋見出し改稿）→原文の章を削除", async () => {
			removeChapter("en/guide.md", "## 第1章 第1章の本文。 [MT]");
			editBody("en/guide.md", "## 第2章 第2章の本文。 [MT]", "## Chapter Two, fully rewritten by hand");
			editBody("en/guide.md", "## 第3章 第3章の本文。 [MT]", "## Chapter Three, fully rewritten by hand");
			removeChapter("ja/guide.md", "## 第2章");
		});

		// S57: 先頭寄りの章を文書の末尾へ移動する（並べ替えの極端形）
		await scenario("S57 第1章を文書の末尾へ移動", async () => {
			moveChapterToEnd("ja/guide.md", "## 第1章");
		});

		// S58: S55 の切り分け。コードブロック内にマーカー風文字列があるだけで（編集ゼロで）
		//      両モードが食い違うかを見る
		await scenario("S58 コードブロック内マーカー風文字列・操作なし", async () => {}, { src: CODE_SRC });

		// S59: S51 の最小形。3ユニットの文書で2章を入れ替え、そのうち片方を編集する
		await scenario(
			"S59 最小形: 2章を入れ替え＋一方を編集",
			async () => {
				swapChapters("ja/guide.md", "## A", "## B");
				editBody("ja/guide.md", "Bの本文。", "Bの本文（改訂）。");
			},
			{ src: ["# ドキュメント", "", "導入の文章。", "", "## A", "", "Aの本文。", "", "## B", "", "Bの本文。", ""].join("\n") },
		);

		// S61: 訳文の既存章の本文に、マーカー風文字列を含むコードブロックを書き足す
		//      （マーカーを翻訳した文書を訳す、という実際に起きる状況。S58 の訳文側版）
		await scenario("S61 訳文の章にマーカー風文字列入りコードブロックを書き足す", async () => {
			editBody(
				"en/guide.md",
				"## 第2章 第2章の本文。 [MT]",
				["## 第2章 第2章の本文。 [MT]", "", "```markdown", "<!-- mdait 12345678 from:87654321 need:translate -->", "## Sample", "```"].join("\n"),
			);
		});

		// S60: 移動と編集の合わせ技（入れ替えでなく片道の移動でも同じことが起きるか）
		await scenario("S60 第1章を末尾へ移動＋その第1章を編集", async () => {
			moveChapterToEnd("ja/guide.md", "## 第1章");
			editBody("ja/guide.md", "第1章の本文。", "第1章の本文（改訂）。");
		});

		// ---- S62〜: 多言語構成（走査対象外のペアの状態が守られるか） ----

		// S62: ja→en と ja→fr の2ペアがある構成で、en だけを選んで sync する。
		//      走査していない fr の状態が消えないかを見る（消えると fr が全 need:review に倒れる）。
		await scenario(
			"S62 多言語（en/fr）で en だけ選んで sync → 全選択に戻す",
			async () => {
				selectTargets(["en"]);
				editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
				await syncCommand();
				selectTargets(["en", "fr"]);
			},
			{ pairs: MULTI_PAIRS },
		);

		// S63: S62 の最小形。原文を1文字も触らず、en だけ選んで sync するだけ。
		//      「走査対象外」を「実体が無い」と取り違えていないかを、編集の影響抜きで見る。
		await scenario(
			"S63 多言語（en/fr）で en だけ選んで sync（編集なし）",
			async () => {
				selectTargets(["en"]);
				await syncCommand();
				selectTargets(["en", "fr"]);
			},
			{ pairs: MULTI_PAIRS },
		);

		// S64: 章を大きく減らして sync（刈り取りが見送られる）→ そのあと新しい章を足す。
		//      取り残された行が、内容の一致しない新章に順序で貼り付かないかを見る。
		//      貼り付くと新章に削除済みの章の from が付き need:revise になる（AI に無関係な差分が渡る）。
		await scenario(
			"S64 章を大きく減らして sync → 新しい章を足す",
			async () => {
				removeLastChapters("ja/guide.md", 15);
				removeLastChapters("en/guide.md", 15);
				await syncCommand();
				appendChapter("ja/guide.md", "## 新章", "新章の本文。");
				appendChapter("en/guide.md", "## New Chapter", "Body of the new chapter.");
			},
			{ src: MANY_SRC },
		);

		// S65: S64 のあいだにマーカー保管方式を embedded へ戻してまた external に戻す。
		//      モード切替は external 側だけの操作なので、embedded 側は S64 と同じ手順を踏む
		//      （＝往復が無損失なら S64 と同じ結果になるはず）。
		//      embed が本文へ書き戻せなかった行を消すと、往復後に状態が失われて差が出る。
		await scenario(
			"S65 章を大きく減らす → embedded へ戻す → external に戻す → 新章を足す",
			async (mode) => {
				removeLastChapters("ja/guide.md", 15);
				removeLastChapters("en/guide.md", 15);
				await syncCommand();
				if (mode === "external") {
					await setMode("embedded", DEFAULT_PAIRS);
					await syncCommand();
					await setMode("external", DEFAULT_PAIRS);
					await syncCommand();
				}
				appendChapter("ja/guide.md", "## 新章", "新章の本文。");
				appendChapter("en/guide.md", "## New Chapter", "Body of the new chapter.");
			},
			{ src: MANY_SRC },
		);

		// S67: 同じディレクトリを指したまま、mdait.json の書き方だけを "./content/ja" に変える。
		//      validateForRun が正当と認めている書き方なので、これで状態が消えてはいけない。
		await scenario(
			'S67 sourceDir/targetDir の表記を "./content/ja" 形式へ変える',
			async () => {
				await setMode("external", DOTTED_PAIRS);
				await syncCommand();
				await setMode("external", DEFAULT_PAIRS);
			},
			{ externalOnly: true },
		);

		// S68: 訳文を一時的に空にして、1文字も違わない元の内容を貼り戻す。
		//      embedded は本文のマーカーごと戻るので完全復帰する。
		await scenario("S68 訳文を空にして、同じ内容を貼り戻す", async () => {
			const saved = read("en/guide.md");
			write("en/guide.md", "");
			await syncCommand();
			write("en/guide.md", saved);
		});

		// S69: 原文にコードブロックの閉じ忘れが入り、以降の章が全部コードとして飲まれる。
		//      訳文が物理削除されないこと、フェンスを直せば元に戻ることを見る。
		await scenario("S69 原文にフェンスの閉じ忘れ → sync → 直して sync", async () => {
			const saved = read("ja/guide.md");
			editBody("ja/guide.md", "導入の文章。", "導入の文章。\n\n```text");
			await syncCommand();
			write("ja/guide.md", saved);
		});

		// S66: 原文ディレクトリは在るが、原文ファイルが一時的に1件も無い状態で sync する。
		//      「見に行ったが0件」を「全部消えた」と読むと、そのペアの行が全消えして
		//      原文を戻したときに全ユニット need:review へ倒れる（S62/S63 と同じ症状）。
		await scenario("S66 原文ファイルを一時退避（ディレクトリは残す）→ sync → 戻す", async () => {
			const abs = path.join(CONTENT, "ja/guide.md");
			const stash = path.join(WS, "guide.md.stash");
			fs.renameSync(abs, stash);
			await syncCommand();
			fs.renameSync(stash, abs);
		});

		// S70: 原文の本文を空にする（全選択して消した・別の内容へ差し替える途中など）。
		//      訳文が丸ごと消えないか（＝作業内容が失われないか）を見る
		await scenario("S70 原文の本文を空にする", async () => {
			write("ja/guide.md", "");
		});

		// S71: 訳文の章にコードブロックを書き足す（人手編集の検知）。
		//      ハッシュが変わったことが状態に反映されるかを見る
		await scenario("S71 訳文の章にコードブロックを書き足す", async () => {
			editBody(
				"en/guide.md",
				"## 第2章 第2章の本文。 [MT]",
				["## 第2章 第2章の本文。 [MT]", "", "```js", "console.log(1);", "```"].join("\n"),
			);
		});

		// S72: S58 のチルダ版。コードブロックの囲いが ``` でなくても同じように扱えるか
		//      （``` 限定の実装だと退避を素通りしてマーカー風文字列が本文に露出する）
		await scenario("S72 チルダのコードブロック内マーカー風文字列・操作なし", async () => {}, {
			src: TILDE_SRC,
			expect: expectLinesIntact("ja/guide.md", [
				"~~~markdown",
				"<!-- mdait 12345678 from:87654321 need:translate -->",
				"## サンプル章",
				"",
				"サンプルの本文。",
				"~~~",
			]),
		});

		// S73: リストと引用の中のコードブロック。行頭の字下げ・引用記号ごと守られるか。
		//      両モードが同じように壊れるため突き合わせでは出ない＝絶対チェックで見る
		await scenario("S73 リスト・引用の中のコードブロック・操作なし", async () => {}, {
			src: NESTED_CODE_SRC,
			expect: (ctx) => {
				const msgs = [
					// 原文: リストの中と引用の中、それぞれが連続したまま残っていること
					...expectLinesIntact("ja/guide.md", ["  ```js", "  console.log(1);", "  ```"])(ctx),
					...expectLinesIntact("ja/guide.md", ["> ```js", "> console.log(2);", "> ```"])(ctx),
					// 訳文: コードブロックが字下げ・引用記号ごと「在る」こと。
					//       否定（壊れた形が無い）だけを見ると、丸ごと消えた場合に素通りする
					...expectLinesPresent("en/guide.md", ["  ```js", "  console.log(1);", "> ```js", "> console.log(2);"])(ctx),
				];
				// 訳文側に、字下げ・引用記号を失った裸のフェンスが生えていないこと
				const tgt = ctx.read("en/guide.md");
				if (tgt !== null) {
					const bare = tgt.split("\n").filter((l) => l === "```js").length;
					if (bare > 0) msgs.push(`en/guide.md に字下げ・引用記号を失った \`\`\`js が ${bare} 行ある`);
				}
				return msgs;
			},
		});

		// S74: 字下げ（4スペース）コードブロック内のマーカー風文字列
		await scenario("S74 字下げコードブロック内マーカー風文字列・操作なし", async () => {}, {
			src: INDENTED_CODE_SRC,
			expect: expectLinesIntact("ja/guide.md", [
				"    ## サンプル章",
				"    <!-- mdait 12345678 from:87654321 need:translate -->",
				"    サンプルの本文。",
			]),
		});
	} finally {
		fs.writeFileSync(CFG_PATH, cfgBackup);
		restoreWorkspace();
	}
	// 絞って走らせたときも突き合わせは出す（シナリオを書きながら確かめられるように）。
	// 終了コードで落とすのは「全件走らせたときの想定外の差」と「絶対チェックの失敗」。
	// 絶対チェックは両モードが揃って壊れる欠陥を見るもので、1シナリオでも成立する。
	const reported = reportModeParity();
	const unexpected = ONLY ? absoluteFailures.length : reported;
	if (ONLY) {
		origLog("（PROBE_ONLY 指定のため想定外の差は終了コードに数えません。絶対チェックの失敗だけ数えます）");
	}
	origLog("\n========== DONE ==========");
	// 保留中のタイマー/ウォッチャで終了しないため明示的に落とす
	process.exit(unexpected > 0 ? 1 : 0);
}

main().catch((e) => {
	origLog("PROBE ERROR:", (e && e.stack) || e);
	process.exit(1);
});
