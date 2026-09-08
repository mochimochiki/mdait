// 「行のあいだに何を置けば、挿入 × すぐ次の行の改訂 が競合しなくなるか」を測る。
// unit-state の並びだけを模した最小の実験（製品コードは通さない）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-"));
const merge = (base, mine, theirs, argv) => {
	const f = (n, c) => {
		const p = path.join(TMP, n);
		fs.writeFileSync(p, c);
		return p;
	};
	const a = f("mine", mine);
	const b = f("base", base);
	const c = f("theirs", theirs);
	try {
		const out = execFileSync(argv[0], [...argv.slice(1), a, b, c], { encoding: "utf-8" });
		return (out.match(/^<{7}/gm) ?? []).length;
	} catch (e) {
		return ((e.stdout ?? "").match(/^<{7}/gm) ?? []).length;
	}
};
const ways = {
	git: ["git", "merge-file", "-p", "--diff3"],
	diff3: ["diff3", "-m"],
	union: ["git", "merge-file", "-p", "--union"],
};

// 並べ方の候補。row = {id, text}
const layouts = {
	"空行1つ（いまの形）": (rows) => rows.map((r) => r.text).join("\n\n"),
	"空行2つ": (rows) => rows.map((r) => r.text).join("\n\n\n"),
	"行ごとの目印（行の前）": (rows) => rows.map((r) => `# ${r.id}\n${r.text}`).join("\n"),
	"行ごとの目印＋空行": (rows) => rows.map((r) => `# ${r.id}\n${r.text}`).join("\n\n"),
	"行ごとの目印（前後）": (rows) => rows.map((r) => `# ${r.id}\n${r.text}\n# /${r.id}`).join("\n"),
};

const R = (id, text) => ({ id, text: text ?? `row-${id}` });
const cases = {
	"挿入 × すぐ次の行を改訂": [
		[R(1), R(2), R(3), R(4)],
		[R(1), R(2), R(25), R(3), R(4)],
		[R(1), R(2), R(3, "row-3-changed"), R(4)],
	],
	"挿入 × すぐ前の行を改訂": [
		[R(1), R(2), R(3), R(4)],
		[R(1), R(2), R(25), R(3), R(4)],
		[R(1), R(2, "row-2-changed"), R(3), R(4)],
	],
	"隣り合う2行をそれぞれ改訂": [
		[R(1), R(2), R(3), R(4)],
		[R(1), R(2, "row-2-changed"), R(3), R(4)],
		[R(1), R(2), R(3, "row-3-changed"), R(4)],
	],
	"1行削除 × すぐ次の行を改訂": [
		[R(1), R(2), R(3), R(4)],
		[R(1), R(3), R(4)],
		[R(1), R(2), R(3, "row-3-changed"), R(4)],
	],
	"両方が同じ隙間へ挿入": [
		[R(1), R(2), R(3), R(4)],
		[R(1), R(2), R(24, "row-A"), R(3), R(4)],
		[R(1), R(2), R(26, "row-B"), R(3), R(4)],
	],
	"両方が別の隙間へ挿入": [
		[R(1), R(2), R(3), R(4)],
		[R(1), R(15, "row-A"), R(2), R(3), R(4)],
		[R(1), R(2), R(3), R(35, "row-B"), R(4)],
	],
};

const names = Object.keys(layouts);
console.log("並べ方ごとの競合数（git/diff3/union）\n");
console.log(`  ${"手順".padEnd(30)}${names.map((n) => n.padEnd(24)).join("")}`);
for (const [name, [b, m, t]] of Object.entries(cases)) {
	const cells = names.map((n) => {
		const f = layouts[n];
		return Object.values(ways)
			.map((w) => merge(`${f(b)}\n`, `${f(m)}\n`, `${f(t)}\n`, w))
			.join("/");
	});
	console.log(`  ${name.padEnd(24)}${cells.map((c) => c.padEnd(20)).join("")}`);
}
fs.rmSync(TMP, { recursive: true, force: true });
