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
import { ASSETS, PAGES } from "./site-content.mjs";
import { writeHugoScaffold } from "./site-hugo.mjs";

/**
 * 見本サイトの言語。原稿の生成と Hugo の設定は**同じこの一覧から**作る（食い違わせない）。
 * 先頭が原文の言語。
 */
export const LANGS = [
	{ code: "ja", name: "日本語" },
	{ code: "en", name: "English" },
];

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

/** 設定ファイル。AI の差し向けは lab up（configureAi）が上書きするので、ここでは書かない */
function renderConfig(markers) {
	return `${JSON.stringify(
		{
			transPairs: [{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" }],
			markers: { mode: markers },
			trans: {
				contextSize: 1,
				retryLimit: 1,
				extensions: [".txt", ".csv", ".json"],
				frontmatter: { keys: ["title", "description"] },
			},
			primaryLang: "ja",
			sync: { level: 3, autoDelete: true, autoSyncOnSave: false },
			tm: { retryLimit: 1, maxReferences: 5 },
			terms: { filename: "terms.csv" },
		},
		null,
		2,
	)}\n`;
}

/**
 * 見本サイトを書き出す。
 *
 * @param {{out?: string, markers?: "embedded"|"external"}} options
 * @returns {{dir: string, files: number, ja: number, en: number, crlf: number, byKind: Record<string, number>}}
 */
export function generateSite(options = {}) {
	const dir = path.resolve(options.out || DEFAULT_SITE_DIR);
	const markers = options.markers === "external" ? "external" : "embedded";
	const content = path.join(dir, "content");

	fs.rmSync(content, { recursive: true, force: true });
	fs.rmSync(path.join(dir, ".mdait"), { recursive: true, force: true });

	const stats = { dir, files: 0, ja: 0, en: 0, crlf: 0, byKind: {} };
	const count = (kind, lang, crlf) => {
		stats.files += 1;
		stats[lang] += 1;
		if (crlf) stats.crlf += 1;
		stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
	};

	for (const page of PAGES) {
		if (page.kind !== "targetOnly") {
			writeText(path.join(content, "ja", page.path), renderPage(page, "ja", page.sections), page.crlf);
			count(page.kind, "ja", page.crlf);
		}
		if (page.kind !== "sourceOnly") {
			const sections = page.kind === "targetOnly" ? page.sections : targetSections(page);
			writeText(path.join(content, "en", page.path), renderPage(page, "en", sections), page.crlf);
			count(page.kind, "en", page.crlf);
		}
	}

	for (const asset of ASSETS) {
		writeText(path.join(content, "ja", asset.path), `${asset.ja}\n`, asset.crlf);
		count("asset", "ja", asset.crlf);
		writeText(path.join(content, "en", asset.path), `${asset.en}\n`, asset.crlf);
		count("asset", "en", asset.crlf);
	}

	fs.mkdirSync(path.join(dir, ".mdait"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".mdait", "mdait.json"), renderConfig(markers), "utf8");

	// 静的サイトジェネレータの足場。content/ の外なので、取り込みの対象には入らない。
	// 「翻訳したあとサイトが建つか」を実物で測るために置いてある（site-hugo.mjs）。
	writeHugoScaffold(dir, LANGS);
	return stats;
}
