"use strict";
/*
 * 探索的スイープ（Extension Host 非依存）。
 *
 * 全 sample ファイルに対し commands 層の「機構」を決定的に検証する:
 *   P1 sync: マーカー整合 / need:translate 付与 / 冪等性（2回目で無変化）
 *   P2 trans: need:translate クリア / trans後 re-sync の観察
 *   P3 revise: 原文変更 → need:revise@oldhash 付与（sync側の差分検知）
 *
 * LLM は決定的モック（sync は AI 非使用で完全決定的、trans/revise は構造化フェイクで正常系のみ）。
 * 実LLMが要る項目（訳質、revise パッチ適用）は対象外で INFO として記録する。
 *
 * 使い方: npm run test:explore   （内部で compile → 本スクリプト）
 * 終了コード: 決定的アサーション（P1 全部 / P2 need クリア / P3 revise 付与）に失敗すると 1。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { vscode, REPO, WS } = require("./vscode-shim");
const { install: installFakeAi } = require("./fake-ai");

// StatusManager 等のノイズ log を抑制
const origLog = console.log;
console.log = (...a) => {
	const s = String(a[0] != null ? a[0] : "");
	if (s.startsWith("StatusManager:") || s.startsWith("DefaultAIProvider")) return;
	origLog(...a);
};

const findings = [];
function fail(phase, file, summary, detail) {
	findings.push({ sev: "FAIL", phase, file, summary, detail });
	origLog(`  [FAIL] (${phase}) ${file}: ${summary}`);
}
function info(phase, file, summary) {
	findings.push({ sev: "INFO", phase, file, summary });
	origLog(`  [INFO] (${phase}) ${file}: ${summary}`);
}
function ok(phase, msg) {
	origLog(`  [OK]   (${phase}) ${msg}`);
}

const CONTENT = path.join(WS, "content");
const CFG_PATH = path.join(WS, ".mdait/mdait.json");
const MARKER_STRICT = /<!-- mdait(?:\s+([a-zA-Z0-9]+))?(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:([\w@-]+))?\s*-->/;
const MARKER_LOOSE = /<!--\s*mdait\b[^>]*-->/g;

function walkFiles(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walkFiles(full, out);
		else out.push(full);
	}
	return out;
}
function snapshot() {
	const map = {};
	for (const f of walkFiles(CONTENT)) map[path.relative(CONTENT, f)] = fs.readFileSync(f, "utf8");
	return map;
}
function markerLines(content) {
	return content.match(MARKER_LOOSE) || [];
}
function needFlag(markerText) {
	const m = MARKER_STRICT.exec(markerText);
	return (m && m[3]) || "";
}
function countNeed(map, prefix) {
	let n = 0;
	for (const content of Object.values(map)) for (const m of markerLines(content)) if (needFlag(m).startsWith(prefix)) n++;
	return n;
}

// mdait.json を「provider=default ＋ 任意の追加設定」で書いて再ロードし、全ペアを選択する。
// extra で trans.extensions / markers.mode などフェーズ固有の設定を注入できる。
async function loadConfigAndSelectAll(extra) {
	const j = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
	j.ai = Object.assign({}, j.ai, { provider: "default", vendor: "default" });
	if (extra && extra.extensions !== undefined) j.trans = Object.assign({}, j.trans, { extensions: extra.extensions });
	if (extra && extra.markersMode !== undefined) j.markers = { mode: extra.markersMode };
	else delete j.markers;
	fs.writeFileSync(CFG_PATH, JSON.stringify(j, null, 2));
	const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
	await Configuration.getInstance().load();
	const { SelectionState } = require(path.join(REPO, "out/core/status/selection-state.js"));
	const sel = SelectionState.getInstance();
	sel.updateSelection(sel.getSelectableTargets().map((t) => t.key));
}

// フェーズ間の状態汚染を避けるため、content を再展開し unit-state（非MD/external の外部ストア）を破棄する。
function resetWorkspace() {
	execSync("npm run copy-test-files", { cwd: REPO, stdio: "ignore" });
	const us = path.join(WS, ".mdait/unit-state");
	if (fs.existsSync(us)) fs.rmSync(us);
}
function readUnitState() {
	const p = path.join(WS, ".mdait/unit-state");
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
// 非front（本文）に埋め込みマーカーが残る .md を列挙する（external 化後は 0 のはず）
function filesWithBodyMarkers(map) {
	const out = [];
	for (const [rel, c] of Object.entries(map)) {
		if (!rel.endsWith(".md")) continue;
		for (const line of c.split("\n")) if (/<!--\s*mdait\b/.test(line) && !line.includes("front")) out.push(rel);
	}
	return [...new Set(out)];
}

const { syncCommand } = require(path.join(REPO, "out/commands/sync/sync-command.js"));
const { transCommand } = require(path.join(REPO, "out/commands/trans/trans-command.js"));
const { externalizeMarkersCommand } = require(path.join(REPO, "out/commands/markers/markers-migration.js"));

async function phase1() {
	const P = "P1-sync";
	const r1 = await syncCommand();
	const snap1 = snapshot();

	let bad = 0;
	for (const [rel, content] of Object.entries(snap1)) {
		if (!rel.endsWith(".md")) continue;
		for (const m of markerLines(content)) {
			const mm = MARKER_STRICT.exec(m);
			if (!mm) {
				bad++;
				fail(P, rel, "マーカーが厳密文法に不一致", m);
				continue;
			}
			for (const h of [mm[1], mm[2]]) if (h && !/^[0-9a-f]{8}$/.test(h)) fail(P, rel, `ハッシュが8桁hexでない: ${h}`, m);
		}
	}
	if (!bad) ok(P, `マーカー整合OK (${Object.keys(snap1).length}ファイル)`);

	const nt = countNeed(snap1, "translate");
	if (nt > 0) ok(P, `need:translate 付与 ${nt}件`);
	else fail(P, "-", "sync後に need:translate が1件も無い", JSON.stringify(r1));

	const r2 = await syncCommand();
	const snap2 = snapshot();
	if (r2.totalAdded !== 0 || r2.totalModified !== 0) fail(P, "-", `2回目 sync が非冪等 (added=${r2.totalAdded}, modified=${r2.totalModified})`, "");
	let diffed = 0;
	for (const rel of new Set([...Object.keys(snap1), ...Object.keys(snap2)]))
		if (snap1[rel] !== snap2[rel]) {
			diffed++;
			fail(P, rel, "2回目 sync でファイル内容が変化（非冪等）", "byte diff");
		}
	if (!diffed && r2.totalAdded === 0 && r2.totalModified === 0) ok(P, "sync 冪等性OK（2回目で無変化）");
}

async function phase2() {
	const P = "P2-trans";
	installFakeAi();
	const targets = walkFiles(CONTENT).filter((f) => f.endsWith(".md") && markerLines(fs.readFileSync(f, "utf8")).some((m) => needFlag(m).startsWith("translate")));
	ok(P, `need:translate を含む target: ${targets.length}ファイル`);
	let translated = 0;
	for (const t of targets) {
		try {
			const res = await transCommand(vscode.Uri.file(t));
			translated += (res && res.translatedCount) || 0;
			const after = fs.readFileSync(t, "utf8");
			const remain = markerLines(after).filter((m) => needFlag(m).startsWith("translate")).length;
			if (remain > 0) fail(P, path.relative(CONTENT, t), `trans後も need:translate が ${remain}件残存`, "");
			for (const m of markerLines(after)) if (!MARKER_STRICT.exec(m)) fail(P, path.relative(CONTENT, t), "trans後にマーカー破損", m);
		} catch (e) {
			fail(P, path.relative(CONTENT, t), "transCommand が例外", String(e && e.message));
		}
	}
	ok(P, `translatedCount 合計 ${translated}`);
	const before = snapshot();
	await syncCommand();
	const after = snapshot();
	let diffed = 0;
	for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[rel] !== after[rel]) diffed++;
	if (diffed === 0) ok(P, "trans後 re-sync 冪等OK");
	else info(P, "-", `trans後 re-sync で ${diffed}ファイル変化（モック訳の再ハッシュに起因。実LLMで要確認）`);
}

async function phase3() {
	const P = "P3-revise";
	const srcFile = path.join(CONTENT, "ja/10_test.md");
	const tgtFile = path.join(CONTENT, "en/10_test.md");
	fs.writeFileSync(srcFile, fs.readFileSync(srcFile, "utf8").replace("# 見出し 1", "# 見出し 1\n\n原文をここで変更した（revise誘発）。"));

	const r = await syncCommand();
	const reviseMarks = markerLines(fs.readFileSync(tgtFile, "utf8")).filter((m) => needFlag(m).startsWith("revise"));
	if (reviseMarks.length === 0) fail(P, "en/10_test.md", "原文変更後の re-sync で need:revise が付与されない", JSON.stringify(r));
	else if (reviseMarks.every((m) => /need:revise@[0-9a-f]{8}/.test(m))) ok(P, `need:revise@oldhash 付与OK (${reviseMarks.length}件)`);
	else fail(P, "en/10_test.md", "need:revise が @oldhash 形式でない", reviseMarks.join(" | "));

	try {
		const tr = await transCommand(vscode.Uri.file(tgtFile));
		const remain = markerLines(fs.readFileSync(tgtFile, "utf8")).filter((m) => needFlag(m).startsWith("revise")).length;
		if (remain > 0) info(P, "en/10_test.md", "revise trans後も need:revise 残存（パッチ形状はモック非対応。実LLMで要確認）");
		else ok(P, `revise trans後 need クリア (patched=${tr && tr.patchedCount}, translated=${tr && tr.translatedCount})`);
	} catch (e) {
		info(P, "en/10_test.md", `revise trans 例外（モック限界）: ${String(e && e.message)}`);
	}
}

// P4: 非MD（PlainFileHandler）— trans.extensions で対象化した csv/txt の
// sync 冪等性・trans need クリア・revise 付与を決定的に検証する。
async function phase4() {
	const P = "P4-nonmd";
	resetWorkspace();
	await loadConfigAndSelectAll({ extensions: [".txt", ".csv"] });

	const r1 = await syncCommand();
	const us1 = readUnitState();
	// 非MD target が unit-state に登録されたか（source ja/ に対し en/・zh-hans/ が生成される）
	const nonMdEntries = us1.split("\n").filter((l) => l && !l.startsWith("#") && /\.(txt|csv)\t/.test(l));
	if (nonMdEntries.length > 0) ok(P, `非MD unit-state エントリ ${nonMdEntries.length}件`);
	else fail(P, "-", "非MD (txt/csv) が unit-state に登録されない（extensions 経路の退行）", JSON.stringify(r1));

	const r2 = await syncCommand();
	const us2 = readUnitState();
	if (us1 === us2 && r2.totalAdded === 0 && r2.totalModified === 0) ok(P, "非MD sync 冪等性OK（2回目で unit-state 無変化）");
	else fail(P, "-", `非MD sync が非冪等 (added=${r2.totalAdded}, modified=${r2.totalModified}, us-stable=${us1 === us2})`, "");

	// 非MD trans → need クリア（フェイクAIで全文翻訳）
	installFakeAi();
	const txt = path.join(CONTENT, "en/notice.txt");
	try {
		await transCommand(vscode.Uri.file(txt));
		const line = readUnitState().split("\n").find((l) => l.includes("en/notice.txt")) || "";
		const need = line.split("\t")[6] || "";
		if (need === "") ok(P, "非MD trans 後に need クリアOK");
		else fail(P, "en/notice.txt", `非MD trans 後も need 残存: ${need}`, line);
	} catch (e) {
		fail(P, "en/notice.txt", "非MD transCommand が例外", String(e && e.message));
	}

	// 原文変更 → sync で revise@oldhash 付与
	const src = path.join(CONTENT, "ja/notice.txt");
	fs.writeFileSync(src, `${fs.readFileSync(src, "utf8")}\n追記（revise誘発）\n`);
	await syncCommand();
	const rline = readUnitState().split("\n").find((l) => l.includes("en/notice.txt")) || "";
	const rneed = rline.split("\t")[6] || "";
	if (/^revise@[0-9a-f]{8}$/.test(rneed)) ok(P, `非MD revise@oldhash 付与OK (${rneed})`);
	else fail(P, "en/notice.txt", `非MD 原文変更後に revise@oldhash が付かない: '${rneed}'`, rline);
}

// P5: external マーカーモード（正規フロー）— externalize で本文からマーカーを退避後、
// sync が本文/unit-state ともに冪等であることと、本文にマーカーが残らないことを検証する。
async function phase5() {
	const P = "P5-external";
	resetWorkspace();
	// まず embedded 既定で sync してマーカーを確定させる
	await loadConfigAndSelectAll();
	await syncCommand();

	// externalize（確認ダイアログは自動承認）
	vscode.window.showWarningMessage = async (_m, _o, label) => label;
	vscode.window.showInformationMessage = async () => undefined;
	await externalizeMarkersCommand();

	const afterExt = snapshot();
	const leftover = filesWithBodyMarkers(afterExt);
	if (leftover.length === 0) ok(P, "externalize 後に本文マーカー無しOK");
	else fail(P, leftover[0], `externalize 後も本文にマーカーが残存 (${leftover.length}ファイル)`, leftover.join(", "));

	// external モードを有効化して再ロード（mode は externalize が書き戻し済みだが明示ロード）
	await loadConfigAndSelectAll({ markersMode: "external" });
	const s1 = await syncCommand();
	const m1 = snapshot();
	const u1 = readUnitState();
	const s2 = await syncCommand();
	const m2 = snapshot();
	const u2 = readUnitState();

	let diffed = 0;
	for (const rel of new Set([...Object.keys(m1), ...Object.keys(m2)])) if (m1[rel] !== m2[rel]) diffed++;
	if (diffed === 0 && u1 === u2 && s2.totalAdded === 0 && s2.totalModified === 0) ok(P, "external sync 冪等性OK（本文・unit-state とも無変化）");
	else fail(P, "-", `external sync が非冪等 (mdDiff=${diffed}, us-stable=${u1 === u2}, added=${s2.totalAdded}, modified=${s2.totalModified})`, "");
	void s1;
}

async function main() {
	const cfgBackup = fs.readFileSync(CFG_PATH);
	try {
		execSync("npm run copy-test-files", { cwd: REPO, stdio: "ignore" });
		await loadConfigAndSelectAll();
		origLog("========== EXPLORATORY SWEEP (headless, provider=default) ==========");
		await phase1();
		await phase2();
		await phase3();
		await phase4();
		await phase5();
	} finally {
		// 共有 mdait.json を必ず元に戻す（provider 上書きを残さない）
		fs.writeFileSync(CFG_PATH, cfgBackup);
	}
	const fails = findings.filter((f) => f.sev === "FAIL");
	origLog("\n========== SUMMARY ==========");
	origLog(`FAIL=${fails.length} INFO=${findings.filter((f) => f.sev === "INFO").length}`);
	process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((e) => {
	origLog("SWEEP ERROR:", (e && e.stack) || e);
	process.exit(1);
});
