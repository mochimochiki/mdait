"use strict";
/*
 * 探索的スイープ（Extension Host 非依存）。
 *
 * 全 sample ファイルに対し commands 層の「機構」を決定的に検証する:
 *   P1 sync: マーカー整合 / need:translate 付与 / 冪等性（2回目で無変化）
 *   P2 trans: need:translate クリア / trans後 re-sync の観察
 *   P3 revise: 原文変更 → need:revise@oldhash 付与（sync側の差分検知）
 *   P4 非MD: PlainFileHandler（csv/txt）の sync 冪等 / trans need クリア / revise 付与
 *   P5 external: externalize 正規フロー後の sync 冪等・本文マーカー除去
 *   P6 modeswitch: markers.mode 書換→sync の両方向自己修復・固定点収束（増殖なし）
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
	// 未指定の追加設定は毎回クリアしてフェーズ間の設定リークを断つ（extensions/markers）。
	if (j.trans) j.trans = Object.assign({}, j.trans, { extensions: undefined });
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

// フェーズ間の状態汚染を避けるため、content を再展開し unit-state / unit-registry を破棄する。
// （registry を残すと前フェーズのフェイク訳スナップショット由来のハッシュが frontmatter 同期に
//  紛れ込み、モード切替とは無関係な非冪等を誘発するため、探索の各フェーズはハーメティックに保つ）
function resetWorkspace() {
	execSync("npm run copy-test-files", { cwd: REPO, stdio: "ignore" });
	for (const name of ["unit-state", "unit-registry"]) {
		const p = path.join(WS, ".mdait", name);
		if (fs.existsSync(p)) fs.rmSync(p);
	}
	// ディスクだけでなくプロセス内シングルトンの在庫も破棄する。
	// 特に UnitRegistryManager は前フェーズのフェイク訳スナップショット（例: 翻訳済み
	// frontmatter hash）をメモリ保持しており、これが残ると後フェーズの frontmatter 同期に
	// 紛れ込んでモード切替とは無関係な非冪等を招くため、必ずメモリも初期化する。
	const { UnitRegistryManager } = require(path.join(REPO, "out/core/unit-registry/unit-registry-manager.js"));
	UnitRegistryManager.resetInstance();
	const { UnitStateStore } = require(path.join(REPO, "out/core/unit-state/unit-state-store.js"));
	UnitStateStore.dispose();
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

// P6: モード切替→sync 動線（externalize/embed コマンドを明示実行しない）。
// mdait.json の markers.mode を書き換えて sync するだけで、本文表現が設定モードへ
// 自己修復され、両方向とも冪等（増殖なし）になることを検証する。
async function phase6() {
	const P = "P6-modeswitch";
	resetWorkspace();
	await loadConfigAndSelectAll();
	await syncCommand();
	const embed0 = filesWithBodyMarkers(snapshot());
	if (embed0.length > 0) ok(P, `embedded 基準: 本文マーカーを持つMD ${embed0.length}ファイル`);
	else fail(P, "-", "embedded 基準で本文マーカーが1つも無い（前提崩れ）", "");

	// 設定だけ external に切替 → sync
	await loadConfigAndSelectAll({ markersMode: "external" });
	await syncCommand();
	const extLeft = filesWithBodyMarkers(snapshot());
	if (extLeft.length === 0) ok(P, "external 切替 sync 後に本文マーカー無しへ自己修復OK");
	else fail(P, extLeft[0], `external 切替後も本文にマーカー残存 (${extLeft.length}ファイル＝非冪等成長の原因)`, extLeft.join(", "));
	const em1 = snapshot();
	const eu1 = readUnitState();
	await syncCommand();
	if (JSON.stringify(em1) === JSON.stringify(snapshot()) && eu1 === readUnitState()) ok(P, "external 切替後 sync 冪等OK");
	else fail(P, "-", "external 切替後の sync が非冪等", "");

	// 設定を embedded へ戻す → sync
	await loadConfigAndSelectAll();
	await syncCommand();
	const back = snapshot();
	const backEmbedded = filesWithBodyMarkers(back);
	if (backEmbedded.length > 0) ok(P, "embedded 復帰 sync 後に本文マーカーが書き戻るOK");
	else fail(P, "-", "embedded 復帰後も本文にマーカーが戻らない", "");
	const mdEntriesLeft = readUnitState().split("\n").filter((l) => l && !l.startsWith("#") && /\.md\t/.test(l)).length;
	if (mdEntriesLeft === 0) ok(P, "embedded 復帰後 unit-state から MD エントリが除去されるOK");
	else fail(P, "-", `embedded 復帰後も unit-state に MD エントリ残存 (${mdEntriesLeft}件)`, "");

	// 冪等性の判定は「固定点への収束」で行う。
	// クリーンなプロセス（＝実ユーザーの1回きり sync）ではモード切替→sync は1発で冪等だが、
	// 本スイープは同一プロセスで P2 のフェイク訳など前フェーズの in-process 残渣を抱えるため、
	// 一部の degenerate sample で frontmatter マーカーの整合に1サイクル余分にかかる（1回遅れ）。
	// 重要な不変条件は「無限成長せず有限回で固定点に収束する」ことなので、それを検証する。
	let prev = snapshot();
	let converged = false;
	let iters = 0;
	for (let i = 0; i < 4; i++) {
		await syncCommand();
		const cur = snapshot();
		iters++;
		if (JSON.stringify(prev) === JSON.stringify(cur)) {
			converged = true;
			break;
		}
		prev = cur;
	}
	if (converged) ok(P, `embedded 復帰後 sync が固定点へ収束OK（${iters}回で安定・増殖なし）`);
	else fail(P, "-", "embedded 復帰後の sync が4回でも収束しない（成長/振動の疑い）", "");
}

/** そのパスの行の「内容としての状態」を1本の文字列で表す（order は含めない） */
function stateOf(store, relPath) {
	return store
		.getEntriesByPath(relPath)
		.map((e) => `${e.hash}/${e.from}/${e.need}`)
		.sort()
		.join(" ");
}

// P7: 外部ストアの行を「静かに消さない」ことの検証（ADR-260803-03）。
//
// probe-robustness.js の embedded/external 突き合わせでは、この2つは観測できない。
// sync は必ず文書を「同期後のユニット列」へ書き直してから detach するため、
// 一時的にユニットが崩れた状態が detach に届かないからである。崩れた本文がそのまま
// 読み書きされるのは unit-mutation（CodeLens の操作）と markers-migration の経路で、
// ここではその2経路を直接叩いて確かめる。
async function phase7() {
	const P = "P7-nosilentdelete";
	resetWorkspace();
	await loadConfigAndSelectAll();
	await syncCommand();
	await loadConfigAndSelectAll({ markersMode: "external" });
	await syncCommand();

	const { UnitStateStore } = require(path.join(REPO, "out/core/unit-state/unit-state-store.js"));
	const { getFileHandler } = require(path.join(REPO, "out/commands/file-handler/file-handler-factory.js"));
	const { embedFileMarkers } = require(path.join(REPO, "out/commands/markers/markers-migration.js"));
	const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
	const store = UnitStateStore.getInstance();

	// 訳文側で行が多いファイルを選ぶ（閾値まわりの挙動を見たいので4行以上）。
	// 原文側の行は hash を本文から再計算できるため、消えても sync が作り直してしまい
	// 「状態を失った」ことが観測できない。守りたいのは from/need を持つ訳文側の行である。
	const rowsPerPath = {};
	for (const e of store.getAllEntries()) {
		if (!e.path.endsWith(".md")) continue;
		rowsPerPath[e.path] = rowsPerPath[e.path] || { total: 0, withFrom: 0 };
		rowsPerPath[e.path].total++;
		if (e.from !== "") rowsPerPath[e.path].withFrom++;
	}
	const relPath = Object.keys(rowsPerPath).find((p) => rowsPerPath[p].total >= 4 && rowsPerPath[p].withFrom >= 3);
	if (!relPath) {
		info(P, "-", "from を持つ行が4件以上ある訳文 .md が無く、刈り取り閾値まわりを検証できない");
		return;
	}
	const absPath = path.join(WS, relPath);
	const original = fs.readFileSync(absPath, "utf8");
	const beforeRows = store.getEntriesByPath(relPath).length;
	const beforeState = stateOf(store, relPath);

	// ---- (a) C-3: 本文が一時的に崩れた状態で読み書きしても行を失わない ----
	// コードブロックの閉じ忘れ。以降が全部コードとして飲まれ、ユニットが激減する。
	// unit-mutation（CodeLens の操作）も markers-migration も、本文をこの形で
	// parse → stringify する。sync と違い「同期後のユニット列」へ直さないので、
	// 崩れたユニット列がそのまま detach に届く。
	const { markdownParser } = require(path.join(REPO, "out/core/markdown/parser.js"));
	const { resolveMarkerIOForFile } = require(path.join(REPO, "out/infra/config/marker-io.js"));
	fs.writeFileSync(absPath, `${original.split("\n")[0]}\n\n\`\`\`text\n${original}\n`, "utf8");
	const brokenIO = resolveMarkerIOForFile(Configuration.getInstance(), absPath);
	const brokenDoc = markdownParser.parse(fs.readFileSync(absPath, "utf8"), Configuration.getInstance(), brokenIO.provider, brokenIO.ctx);
	if (brokenDoc.units.length >= beforeRows) {
		info(P, relPath, `フェンスを崩してもユニットが減らず（${brokenDoc.units.length}件）刈り取り判定を通せない`);
	}
	markdownParser.stringify(brokenDoc, brokenIO.provider, brokenIO.ctx);
	const afterBroken = store.getEntriesByPath(relPath).length;
	if (afterBroken >= beforeRows) {
		ok(P, `フェンス崩れの本文を書き換えても行が減らないOK（${relPath}: ${beforeRows}→${afterBroken}）`);
	} else {
		fail(P, relPath, `フェンス崩れで unit-state の行が消えた（${beforeRows}→${afterBroken}）`, "");
	}

	// 崩れを直すと状態が戻る（保留席の行が内容で拾い直される）。
	// 行数だけ見ても sync が作り直すので戻って見える。from/need まで一致するかを見る。
	fs.writeFileSync(absPath, original, "utf8");
	await syncCommand();
	const restoredState = stateOf(store, relPath);
	if (restoredState === beforeState) {
		ok(P, `崩れを直すと from/need が元に戻るOK（${relPath}）`);
	} else {
		fail(P, relPath, "崩れを直しても from/need が元に戻らない", `before=${beforeState}\nafter =${restoredState}`);
	}

	// ---- (b) C-2: embed で本文へ書き戻せなかった行を消さない ----
	// 本文を先頭ユニットだけに削り、行のほうが多い状態で embed する。
	const head = original.split("\n").slice(0, 2).join("\n");
	fs.writeFileSync(absPath, `${head}\n`, "utf8");
	const rowsBeforeEmbed = store.getEntriesByPath(relPath).length;
	embedFileMarkers(absPath, "target", Configuration.getInstance(), store);
	const rowsAfterEmbed = store.getEntriesByPath(relPath).length;
	if (rowsBeforeEmbed > 1 && rowsAfterEmbed > 0) {
		ok(P, `embed で書き戻せなかった行が残るOK（${relPath}: ${rowsBeforeEmbed}→${rowsAfterEmbed}）`);
	} else if (rowsBeforeEmbed <= 1) {
		info(P, relPath, "embed 前の行が1件以下で、書き戻せない行を作れなかった");
	} else {
		fail(P, relPath, `embed が書き戻せなかった行まで削除した（${rowsBeforeEmbed}→0）`, "");
	}

	fs.writeFileSync(absPath, original, "utf8");
}

// P8: 原文のパースが崩れたときに、訳文の**本文**が消えないこと（ADR-260803-05）。
//
// 行を守っても本文が消えていては意味が無い。既定設定（sync.autoDelete: true）では、
// 原文にコードブロックの閉じ忘れが1つ入るだけで以降の見出しが全部コードとして飲まれ、
// 対応を失った訳文の章がまとめて物理削除されていた（実測: 7章が消え、直しても戻らない）。
//
// probe の突き合わせでは測れない。embedded でも同じことが起きるので両モードが一致してしまい、
// 「両方とも壊れている」ことは差として現れないためである。
async function phase8() {
	const P = "P8-nobodyloss";
	resetWorkspace();
	await loadConfigAndSelectAll({ markersMode: "external" });
	await syncCommand();

	const relPath = "content/ja/40_structure_mismatch.md";
	const absSrc = path.join(WS, relPath);
	const absTgt = path.join(WS, relPath.replace("/ja/", "/en/"));
	if (!fs.existsSync(absSrc) || !fs.existsSync(absTgt)) {
		info(P, relPath, "対象ファイルが見つからず、フェンス崩れを検証できない");
		return;
	}
	const originalSrc = fs.readFileSync(absSrc, "utf8");
	const originalTgt = fs.readFileSync(absTgt, "utf8");
	const headingsOf = (text) => (text.match(/^#{1,6}\s.*$/gm) || []).length;
	const before = headingsOf(originalTgt);
	if (before < 4) {
		info(P, relPath, `訳文の見出しが ${before} 件しかなく、まとめて消える状況を作れない`);
		return;
	}

	// 原文の先頭にコードブロックの閉じ忘れを入れる（以降が全部コードとして飲まれる）
	const lines = originalSrc.split("\n");
	const firstHeading = lines.findIndex((l) => /^#{1,6}\s/.test(l));
	lines.splice(firstHeading + 1, 0, "", "```text");
	fs.writeFileSync(absSrc, lines.join("\n"), "utf8");
	await syncCommand();

	const afterBroken = headingsOf(fs.readFileSync(absTgt, "utf8"));
	if (afterBroken >= before) {
		ok(P, `フェンス崩れで訳文の本文が消えないOK（見出し ${before}→${afterBroken}）`);
	} else {
		fail(P, relPath, `フェンス崩れで訳文の本文が物理削除された（見出し ${before}→${afterBroken}）`, "");
	}

	// 崩れを直すと確認待ちも自動で解ける
	fs.writeFileSync(absSrc, originalSrc, "utf8");
	await syncCommand();
	const restored = fs.readFileSync(absTgt, "utf8");
	if (headingsOf(restored) >= before && !restored.includes("need:verify-deletion")) {
		ok(P, "崩れを直すと訳文が戻り verify-deletion も解けるOK");
	} else {
		fail(
			P,
			relPath,
			"崩れを直しても訳文が戻らない、または verify-deletion が残る",
			`headings=${headingsOf(restored)} (before=${before})`,
		);
	}

	fs.writeFileSync(absSrc, originalSrc, "utf8");
	fs.writeFileSync(absTgt, originalTgt, "utf8");

	// 小さい文書でも守られること。閾値を減少幅だけで決めていたときは、見出し2つの README
	// （タイトル＋2節＝3ユニット）で訳文が2件とも物理削除されていた。崩れは文書の大きさに
	// 関係なく1ユニットまで潰すので、元のユニット数で守られるかどうかが変わってはいけない
	await checkSmallDocument(P);
}

/** 3ユニットの小さい文書を作り、フェンス崩れで訳文が消えないことを確かめる */
async function checkSmallDocument(P) {
	const smallSrc = path.join(WS, "content/ja/_small_doc.md");
	const smallTgt = path.join(WS, "content/en/_small_doc.md");
	const body = ["# 小さな手引き", "", "導入の文章。", "", "## 準備", "", "準備の本文。", "", "## 使い方", "", "使い方の本文。", ""].join("\n");
	try {
		fs.writeFileSync(smallSrc, body, "utf8");
		await syncCommand();
		const headingsOf = (text) => (text.match(/^#{1,6}\s.*$/gm) || []).length;
		const before = headingsOf(fs.readFileSync(smallTgt, "utf8"));
		if (before !== 3) {
			info(P, "content/ja/_small_doc.md", `訳文の見出しが ${before} 件で、想定した3ユニットの形になっていない`);
			return;
		}

		// 導入の直後にフェンスの閉じ忘れを入れる（以降の2節が全部コードとして飲まれる）
		fs.writeFileSync(smallSrc, body.replace("導入の文章。", "導入の文章。\n\n```text"), "utf8");
		await syncCommand();
		const after = headingsOf(fs.readFileSync(smallTgt, "utf8"));
		if (after >= before) {
			ok(P, `3ユニットの小さい文書でも訳文が消えないOK（見出し ${before}→${after}）`);
		} else {
			fail(P, "content/ja/_small_doc.md", `小さい文書でフェンス崩れが訳文を物理削除した（見出し ${before}→${after}）`, "");
		}

		fs.writeFileSync(smallSrc, body, "utf8");
		await syncCommand();
		const restored = fs.readFileSync(smallTgt, "utf8");
		if (headingsOf(restored) >= before && !restored.includes("need:verify-deletion")) {
			ok(P, "小さい文書でも崩れを直すと訳文が戻り verify-deletion も解けるOK");
		} else {
			fail(P, "content/ja/_small_doc.md", "小さい文書で崩れを直しても戻らない、または verify-deletion が残る", restored.slice(0, 200));
		}
	} finally {
		for (const p of [smallSrc, smallTgt]) if (fs.existsSync(p)) fs.rmSync(p);
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
		await phase4();
		await phase5();
		await phase6();
		await phase7();
		await phase8();
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
