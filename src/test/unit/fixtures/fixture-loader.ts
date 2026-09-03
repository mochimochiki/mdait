import * as fs from "node:fs";
import * as path from "node:path";

export interface FixtureMetadata {
	description: string;
	syncLevel: number;
	expectedUnits: number;
}

export interface Fixture {
	name: string;
	markdown: string;
	metadata: FixtureMetadata;
}

/**
 * 指定サブディレクトリからfixtureファイルを読み込む
 * .mdファイルと対応する.jsonサイドカーファイルのペアをロードする
 * @param subDir fixtures配下のサブディレクトリ名
 * @returns Fixture配列（名前順ソート済み）
 */
export function loadFixtures(subDir: string): Fixture[] {
	// コンパイル後はout/test/unit/fixtures/にいるため、src/test/unit/fixtures/を参照する
	const dir = path.resolve(__dirname, "../../../../src/test/unit/fixtures", subDir);
	const mdFiles = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	return mdFiles.map((mdFile) => {
		const name = path.basename(mdFile, ".md");
		const markdown = fs.readFileSync(path.join(dir, mdFile), "utf-8");
		const jsonFile = path.join(dir, `${name}.json`);
		const metadata: FixtureMetadata = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
		return { name, markdown, metadata };
	});
}
