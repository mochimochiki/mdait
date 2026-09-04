/*
 * 見本サイトを静的サイトジェネレータ（Hugo）で実際に建てるための足場。
 *
 * 何のためにあるか: mdait が書式を守れているかは、これまで「原稿のバイト列が変わらない」
 * ことでしか測れていなかった。サイトの持ち主が本当に見るのは**建ったサイト**である。
 * frontmatter の型が崩れれば Hugo はその場で失敗し、本文の構造が崩れれば出力の HTML が変わる。
 * 取り込みの前後で建てて比べれば、「壊れていない」を実物で言える。
 *
 * Hugo 本体はリポジトリに入れない。PATH か MDAIT_HUGO_BIN から探し、無ければ「試せなかった」
 * として素通りする（CI で必須にはしない）。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Hugo の実行ファイルを探す。見つからなければ null */
export function findHugo() {
	const explicit = process.env.MDAIT_HUGO_BIN;
	if (explicit && fs.existsSync(explicit)) return explicit;
	const probe = spawnSync("hugo", ["version"], { encoding: "utf8" });
	if (!probe.error && probe.status === 0) return "hugo";
	return null;
}

/**
 * 設定ファイル。言語の一覧は原稿の生成と同じものを受け取る（食い違わせない）。
 *
 * `unsafe = true` は生の HTML を通すため。実サイトの原稿には必ず混ざるので、
 * 見本にも入れてある。ここで落とすと、そもそも原稿を再現できない。
 */
export function renderHugoConfig(langs) {
	const lines = [
		'baseURL = "https://example.com/"',
		'title = "Kumo Note"',
		`defaultContentLanguage = "${langs[0].code}"`,
		"defaultContentLanguageInSubdir = true",
		"enableInlineShortcodes = true",
		"",
		"[markup.goldmark.renderer]",
		"  unsafe = true",
		"",
		"[languages]",
	];
	langs.forEach((lang, index) => {
		lines.push(`  [languages.${lang.code}]`);
		lines.push(`    contentDir = "content/${lang.code}"`);
		lines.push(`    languageName = "${lang.name}"`);
		lines.push(`    weight = ${index + 1}`);
	});
	return `${lines.join("\n")}\n`;
}

/**
 * テーマを持たない最小のレイアウト。
 *
 * 見た目は測らない。測るのは「建つか」と「本文が同じ形で出るか」なので、
 * 本文をそのまま出すだけの薄いものにしてある。
 */
const LAYOUTS = {
	"_default/baseof.html": [
		"<!DOCTYPE html>",
		'<html lang="{{ .Site.Language.Lang }}">',
		'<head><meta charset="utf-8"><title>{{ .Title }}</title>',
		'<meta name="description" content="{{ .Description }}"></head>',
		'<body>{{ block "main" . }}{{ end }}</body>',
		"</html>",
		"",
	].join("\n"),
	"_default/single.html": [
		'{{ define "main" }}',
		"<article>",
		"<h1>{{ .Title }}</h1>",
		'{{ with .Params.tags }}<ul class="tags">{{ range . }}<li>{{ . }}</li>{{ end }}</ul>{{ end }}',
		"{{ .Content }}",
		"</article>",
		"{{ end }}",
		"",
	].join("\n"),
	"_default/list.html": [
		'{{ define "main" }}',
		"<h1>{{ .Title }}</h1>",
		"{{ .Content }}",
		'<ul>{{ range .Pages }}<li><a href="{{ .RelPermalink }}">{{ .Title }}</a></li>{{ end }}</ul>',
		"{{ end }}",
		"",
	].join("\n"),
	"shortcodes/note.html": ['<aside class="note">{{ .Inner | markdownify }}</aside>', ""].join("\n"),
};

/** レイアウトと設定を書き出す。原稿（content/）には触らない */
export function writeHugoScaffold(dir, langs) {
	fs.writeFileSync(path.join(dir, "hugo.toml"), renderHugoConfig(langs), "utf8");
	for (const [rel, body] of Object.entries(LAYOUTS)) {
		const file = path.join(dir, "layouts", rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body, "utf8");
	}
}

/** 出力の中身を「ファイル名 → 中身のハッシュ」で表す。取り込みの前後を比べるため */
function digestPublic(publicDir) {
	const map = {};
	const walk = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			const rel = path.relative(publicDir, full);
			map[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex").slice(0, 16);
		}
	};
	if (fs.existsSync(publicDir)) walk(publicDir);
	return map;
}

/**
 * 見本サイトを建てる。
 *
 * @param {{dir: string, out?: string, minify?: boolean}} options
 * @returns {{ok: boolean, skipped?: string, code: number|null, seconds: number, stderr: string, pages: number, digest: Record<string,string>}}
 */
export function buildSite(options) {
	const dir = path.resolve(options.dir);
	const hugo = findHugo();
	if (!hugo) {
		return {
			ok: false,
			skipped: "hugo が見つかりません（PATH か MDAIT_HUGO_BIN で指してください）",
			code: null,
			seconds: 0,
			stderr: "",
			pages: 0,
			digest: {},
		};
	}
	const publicDir = path.resolve(options.out || path.join(dir, "public"));
	fs.rmSync(publicDir, { recursive: true, force: true });
	const args = ["--source", dir, "--destination", publicDir, "--logLevel", "warn"];
	if (options.minify !== false) args.push("--minify");
	const started = Date.now();
	const result = spawnSync(hugo, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	const seconds = Math.round((Date.now() - started) / 100) / 10;
	const digest = digestPublic(publicDir);
	const pages = Object.keys(digest).filter((rel) => rel.endsWith(".html")).length;
	// そもそも起こせなかったとき（実行ファイルが無い・権限が無い・出力が上限を超えた）は
	// status が null で stderr も空になる。**理由は result.error にしか無い**ので、
	// 拾わないと呼び手には「終了コード null」としか出ない。
	const failedToStart = result.error ? `Hugo を起こせませんでした: ${result.error.message}` : "";
	return {
		ok: !result.error && result.status === 0,
		code: result.status,
		seconds,
		stderr: [failedToStart, result.stderr ?? "", result.stdout ?? ""].join("").trim(),
		pages,
		digest,
	};
}

/** 2つのビルド結果を比べ、増えた・消えた・中身が変わったファイルを出す */
export function compareDigests(before, after) {
	const added = Object.keys(after)
		.filter((k) => !(k in before))
		.sort();
	const removed = Object.keys(before)
		.filter((k) => !(k in after))
		.sort();
	const changed = Object.keys(after)
		.filter((k) => k in before && before[k] !== after[k])
		.sort();
	return { added, removed, changed };
}
