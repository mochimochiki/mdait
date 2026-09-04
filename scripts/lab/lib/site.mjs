/*
 * 規模のある見本サイトを作る。
 *
 * 何のためにあるか: 取り込み（adopt）を「小さな見本で1回」ではなく、
 * 実運用に近い数のファイルで端から端まで走らせるため。所要時間・往復数・費用を
 * 実測して外挿できるようにするのが目的なので、中身は毎回同じ（乱数を使わない）。
 *
 * 置き場は既定で /tmp/mdait-site。**lab の作業場（/tmp/mdait-lab）の下には置かない** —
 * その下は「使い捨て」と見なされ、原稿が単体テストの見本で上書きされる。
 *
 * 原稿そのものは site-content.mjs にある。ここはそれを並べて書き出すだけ。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS, EXTRA_LANGS, PAGES } from "./site-content.mjs";
import { writeHugoScaffold } from "./site-hugo.mjs";

/**
 * 見本サイトの土台になる対。先頭が原文の言語。
 * 原稿の生成と Hugo の設定は**同じこの一覧から**作る（食い違わせない）。
 */
export const BASE_LANGS = [
	{ code: "ja", name: "日本語" },
	{ code: "en", name: "English" },
];

/**
 * 使う言語を決める。土台の対（ja → en）は常にあり、そこへ対象言語を足せる。
 *
 * 足した言語は**一部のページにしか訳文が無い**（site-content.mjs の `EXTRA_LANGS`）。
 * 実サイトで言語を増やす途中がその形だからで、`ADR-260825-01` が決めた
 * 「設定した対象言語は初回から全部が対象」を、揃い方の違う2本の対で確かめられる。
 */
function resolveLangs(extra) {
	const wanted = (extra ?? []).map((code) => code.trim()).filter(Boolean);
	const langs = [...BASE_LANGS];
	for (const code of wanted) {
		const found = EXTRA_LANGS.find((lang) => lang.code === code);
		if (!found) {
			throw new Error(`知らない対象言語です: ${code}（選べるのは ${EXTRA_LANGS.map((l) => l.code).join(", ")}）`);
		}
		if (!langs.some((lang) => lang.code === code))
			langs.push({ code: found.code, name: found.name, pages: found.pages });
	}
	return langs;
}

/** 既定の置き場（lab の作業場の外） */
export const DEFAULT_SITE_DIR = process.env.MDAIT_SITE_DIR || "/tmp/mdait-site";

/** 改行を揃えて書く。CRLF の原稿を混ぜるのは「勝手に書き換わらない」ことを測るため */
function writeText(file, text, crlf) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = crlf ? text.replace(/\n/g, "\r\n") : text;
	fs.writeFileSync(file, body, "utf8");
}

/**
 * 訳す対象の値を1つ書く。
 *
 * 引用符の付け方は原稿ごとに違う（裸・シングル・ダブル）。実サイトの原稿はどれも混ざっているし、
 * mdait は「原稿にあった形のまま返す」と決めている（ADR-260903-07）ので、見本にも3通りを混ぜる。
 */
function fmValue(key, value, quote) {
	if (quote === "none") return `${key}: ${value}`;
	if (quote === "single") return `${key}: '${value}'`;
	return `${key}: "${value}"`;
}

/**
 * frontmatter を組み立てる。
 *
 * `title` と `description` だけが訳す対象（`.mdait/mdait.json` の `trans.frontmatter.keys`）。
 * それ以外の鍵は「訳す対象ではないものが混ざっても判定に巻き込まれない」ことを見るために置いてある。
 * 型もわざと散らしてある（数値・真偽値・日付・配列・複数行）— 静的サイトジェネレータは
 * これらを型として読むので、引用符が落ちたり型が変わったりすればビルドがその場で失敗する。
 */
function frontmatter(page, lang) {
	const quote = page.quote ?? "double";
	const lines = ["---"];
	lines.push(fmValue("title", page.title[lang], quote));
	lines.push(fmValue("description", page.description[lang], quote));
	if (page.weight !== undefined) lines.push(`weight: ${page.weight}`);
	const extra = page.fm ? (Array.isArray(page.fm) ? page.fm : page.fm[lang]) : undefined;
	if (extra) lines.push(...extra);
	lines.push("---");
	return lines.join("\n");
}

/**
 * 章1つ分の本文。先頭の章だけ H1、以降は H2。
 *
 * 本文が空の章（見出しだけ）も作れる。実サイトの原稿には「書きかけ」として残っていることがあり、
 * 中身の無いユニットが翻訳の経路をどう通るかは、小さな見本では出てこない。
 */
function renderSection(section, lang, index) {
	const hash = index === 0 ? "#" : "##";
	const heading = typeof section.h === "string" ? section.h : section.h[lang];
	const body = typeof section.b === "string" ? section.b : section.b[lang];
	return body ? `${hash} ${heading}\n\n${body}` : `${hash} ${heading}`;
}

/**
 * 訳文の側の章の並びを、パターンごとに作り替える。
 * 先頭の章（H1）は動かさない — 「中間の章が落ちている／入れ替わっている」を作りたいので。
 */
function targetSections(page) {
	const head = page.sections.slice(0, 1);
	const rest = page.sections.slice(1);
	switch (page.kind) {
		case "missingSection":
			// 中間の章を1つ落とす（パターン2）
			return [...head, ...rest.filter((_, i) => i !== 1)];
		case "reordered": {
			// 後ろ2つを入れ替える（パターン4）
			if (rest.length < 3) return [...head, ...rest];
			const swapped = [...rest];
			const last = swapped.length - 1;
			[swapped[last - 1], swapped[last]] = [swapped[last], swapped[last - 1]];
			return [...head, ...swapped];
		}
		case "targetExtra": {
			// 原文に無い章を訳文だけに差し込む（パターン3）
			const extra = page.targetExtraSection;
			const all = [...head, ...rest];
			const inserted = [...all];
			inserted.splice(extra.at, 0, { h: extra.h, b: extra.b });
			return inserted;
		}
		default:
			return [...head, ...rest];
	}
}

/** 1ページ分の Markdown */
function renderPage(page, lang, sections) {
	const parts = [frontmatter(page, lang)];
	sections.forEach((section, index) => {
		parts.push(renderSection(section, lang, index));
	});
	return `${parts.join("\n\n")}\n`;
}

/**
 * 設定ファイル。AI の差し向けは lab up（configureAi）が上書きするので、ここでは書かない。
 *
 * `transPairs` は言語の一覧から作る。**対象言語を足せば対も増える** — 1つのコマンドが
 * 何言語ぶん走るかは、ここが決めている。
 */
function renderConfig(markers, langs) {
	const [source, ...targets] = langs;
	return `${JSON.stringify(
		{
			transPairs: targets.map((target) => ({
				sourceLang: source.code,
				sourceDir: `content/${source.code}`,
				targetLang: target.code,
				targetDir: `content/${target.code}`,
			})),
			markers: { mode: markers },
			trans: {
				contextSize: 1,
				retryLimit: 1,
				extensions: [".txt", ".csv", ".json"],
				frontmatter: { keys: ["title", "description"] },
			},
			primaryLang: source.code,
			sync: { level: 3, autoDelete: true, autoSyncOnSave: false },
			tm: { retryLimit: 1, maxReferences: 5 },
			terms: { filename: "terms.csv" },
		},
		null,
		2,
	)}\n`;
}

/**
 * 足した対象言語のページを、既存の書き出しに載る形へ整える。
 *
 * 書式に関わる指定（引用符の付け方・weight・改行コード）は原文のページから引き継ぐ。
 * 訳す対象ではない frontmatter の鍵は、言語ごとの指定があればそれを、無ければ原文のものを使う。
 */
function asTranslated(page, lang, translated) {
	const fm = Array.isArray(page.fm) ? page.fm : (translated.fm ?? page.fm?.[Object.keys(page.fm)[0]]);
	return {
		...page,
		fm,
		title: { [lang]: translated.title },
		description: { [lang]: translated.description },
	};
}

/**
 * 見本サイトを書き出す。
 *
 * @param {{out?: string, markers?: "embedded"|"external", extraLangs?: string[]}} options
 * @returns {{dir: string, files: number, byLang: Record<string, number>, crlf: number, byKind: Record<string, number>, langs: string[]}}
 */
export function generateSite(options = {}) {
	const dir = path.resolve(options.out || DEFAULT_SITE_DIR);
	const markers = options.markers === "external" ? "external" : "embedded";
	const langs = resolveLangs(options.extraLangs);
	const [source, base, ...extras] = langs;
	const content = path.join(dir, "content");

	fs.rmSync(content, { recursive: true, force: true });
	fs.rmSync(path.join(dir, ".mdait"), { recursive: true, force: true });

	const stats = { dir, files: 0, byLang: {}, crlf: 0, byKind: {}, langs: langs.map((lang) => lang.code) };
	const write = (lang, rel, text, crlf, kind) => {
		writeText(path.join(content, lang, rel), text, crlf);
		stats.files += 1;
		stats.byLang[lang] = (stats.byLang[lang] ?? 0) + 1;
		if (crlf) stats.crlf += 1;
		stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
	};

	for (const page of PAGES) {
		if (page.kind !== "targetOnly") {
			write(source.code, page.path, renderPage(page, source.code, page.sections), page.crlf, page.kind);
		}
		if (page.kind !== "sourceOnly") {
			const sections = page.kind === "targetOnly" ? page.sections : targetSections(page);
			write(base.code, page.path, renderPage(page, base.code, sections), page.crlf, page.kind);
		}
		// 足した対象言語。**訳文があるページだけ**書く（無いページは、これから訳す扱いになる）
		for (const lang of extras) {
			const translated = lang.pages?.[page.path];
			if (!translated) continue;
			write(
				lang.code,
				page.path,
				renderPage(asTranslated(page, lang.code, translated), lang.code, translated.sections),
				page.crlf,
				"extraLang",
			);
		}
	}

	for (const asset of ASSETS) {
		write(source.code, asset.path, `${asset[source.code]}\n`, asset.crlf, "asset");
		write(base.code, asset.path, `${asset[base.code]}\n`, asset.crlf, "asset");
	}

	fs.mkdirSync(path.join(dir, ".mdait"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".mdait", "mdait.json"), renderConfig(markers, langs), "utf8");

	// 静的サイトジェネレータの足場。content/ の外なので、取り込みの対象には入らない。
	// 「翻訳したあとサイトが建つか」を実物で測るために置いてある（site-hugo.mjs）。
	writeHugoScaffold(dir, langs);
	return stats;
}
