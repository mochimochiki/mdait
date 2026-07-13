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

async function loadConfigAndSelectAll() {
	const j = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
	j.ai = Object.assign({}, j.ai, { provider: "default", vendor: "default" });
	fs.writeFileSync(CFG_PATH, JSON.stringify(j, null, 2));
	const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
	await Configuration.getInstance().load();
	const { SelectionState } = require(path.join(REPO, "out/core/status/selection-state.js"));
	const sel = SelectionState.getInstance();
	sel.updateSelection(sel.getSelectableTargets().map((t) => t.key));
}

const { syncCommand } = require(path.join(REPO, "out/commands/sync/sync-command.js"));
const { transCommand } = require(path.join(REPO, "out/commands/trans/trans-command.js"));

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

async function main() {
	const cfgBackup = fs.readFileSync(CFG_PATH);
	try {
		execSync("npm run copy-test-files", { cwd: REPO, stdio: "ignore" });
		await loadConfigAndSelectAll();
		origLog("========== EXPLORATORY SWEEP (headless, provider=default) ==========");
		await phase1();
		await phase2();
		await phase3();
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
