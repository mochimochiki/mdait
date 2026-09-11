/**
 * `.mdait` の未解決の競合を数える係のテスト（roadmap-v04 P01）。
 *
 * ここが持つ約束は2つある。**1バイトも書かないこと**と、**数え落とさないこと**である。
 * 数え落とすと、いままでと同じ「消えたことに気づけない」状態に戻る。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MdaitConflictScanner,
	type ConflictFilePaths,
	collectMdaitConflicts,
} from "../../../../core/conflict/mdait-conflicts";
import type { UnitStateEntry } from "../../../../core/unit-state/unit-state-store";
import { seat } from "../../helpers/unit-state";

const CONFLICTED = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs\n";

/** 更新時刻を固定するための、秒ちょうどの時刻（`utimesSync` の刻みは秒） */
const PINNED = new Date(1_700_000_000_000);

suite(".mdait の未解決の競合を数える", () => {
	let tempDir: string;
	let paths: ConflictFilePaths;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-conflicts-"));
		paths = {
			unitState: path.join(tempDir, "unit-state"),
			unitRegistry: path.join(tempDir, "unit-registry"),
			tm: path.join(tempDir, "translations.tmx"),
			terms: path.join(tempDir, "glossary.yaml"),
		};
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const write = (filePath: string, content: string) => fs.writeFileSync(filePath, content, "utf-8");

	const heldRow = (overrides: Partial<UnitStateEntry> = {}): UnitStateEntry => ({
		path: "en/a.md",
		kind: "held",
		seat: `u${seat(0)}`,
		level: 1,
		titleHash: "th",
		hash: "HASH",
		from: "src",
		need: "revise@old",
		...overrides,
	});

	test("何も無い作業場では 0 件", () => {
		assert.equal(collectMdaitConflicts(paths).total, 0);
	});

	test("競合マーカーの無いファイルは数えない", () => {
		write(paths.unitState, "# mdait unit-state\n");
		write(paths.tm, "<tmx><body></body></tmx>\n");

		assert.equal(collectMdaitConflicts(paths).total, 0);
	});

	test("4つのファイルそれぞれを数える", () => {
		write(paths.unitState, CONFLICTED);
		write(paths.unitRegistry, CONFLICTED);
		write(paths.tm, CONFLICTED);
		write(paths.terms, CONFLICTED);

		const found = collectMdaitConflicts(paths);
		assert.equal(found.total, 4);
		assert.deepEqual(
			found.files.map((f) => f.kind).sort(),
			["terms", "tm", "unit-registry", "unit-state"],
		);
	});

	test("用語集は設定から解決した実ファイルを見る（terms.csv 決め打ちにしない）", () => {
		write(path.join(tempDir, "terms.csv"), CONFLICTED); // 使われていない既定の名前
		write(paths.terms, CONFLICTED); // 設定が指している実ファイル

		const found = collectMdaitConflicts(paths);
		assert.equal(found.total, 1);
		assert.equal(found.files[0].filePath, paths.terms);
	});

	test("合流で降ろされた行を数える", () => {
		const found = collectMdaitConflicts(paths, [heldRow()]);

		assert.equal(found.total, 1);
		assert.equal(found.heldRows[0].path, "en/a.md");
		assert.equal(found.heldRows[0].need, "revise@old");
	});

	test("本文から消えた章を預かる行は数えない", () => {
		const parked = heldRow({ seat: "" });

		assert.equal(collectMdaitConflicts(paths, [parked]).total, 0);
	});

	test("席に着いている行は数えない", () => {
		const live = heldRow({ kind: "unit", seat: seat(0) });

		assert.equal(collectMdaitConflicts(paths, [live]).total, 0);
	});

	test("ファイルと行の両方があれば足して数える", () => {
		write(paths.tm, CONFLICTED);

		assert.equal(collectMdaitConflicts(paths, [heldRow()]).total, 2);
	});

	test("数えるだけで、1バイトも書かない", () => {
		write(paths.unitState, CONFLICTED);
		const before = fs.statSync(paths.unitState);

		collectMdaitConflicts(paths, [heldRow()]);

		const after = fs.statSync(paths.unitState);
		assert.equal(fs.readFileSync(paths.unitState, "utf-8"), CONFLICTED);
		assert.equal(after.mtimeMs, before.mtimeMs);
	});

	suite("覚え書き付きの数え方（MdaitConflictScanner）", () => {
		/** 更新時刻を秒ちょうどに固定する（読み直しの判断から時刻の揺れを外す） */
		const pinMtime = (filePath: string) => fs.utimesSync(filePath, PINNED, PINNED);

		test("見た目が動いていなければ読み直さない", () => {
			write(paths.unitRegistry, CONFLICTED);
			pinMtime(paths.unitRegistry);
			const scanner = new MdaitConflictScanner();
			assert.equal(scanner.scan(paths).total, 1);

			// 更新時刻も寸法も変えずに中身だけ差し替える（読み直していれば 0 になる）
			fs.writeFileSync(paths.unitRegistry, "x".repeat(CONFLICTED.length), "utf-8");
			pinMtime(paths.unitRegistry);

			assert.equal(scanner.scan(paths).total, 1, "覚え書きが効いていない");
		});

		test("見た目が動いたら読み直す", () => {
			write(paths.unitRegistry, CONFLICTED);
			const scanner = new MdaitConflictScanner();
			assert.equal(scanner.scan(paths).total, 1);

			write(paths.unitRegistry, "解決しました\n");

			assert.equal(scanner.scan(paths).total, 0);
		});

		test("行はファイルを読み直さなくても毎回数え直す", () => {
			const scanner = new MdaitConflictScanner();
			assert.equal(scanner.scan(paths).total, 0);

			assert.equal(scanner.scan(paths, [heldRow()]).total, 1);
		});

		test("invalidate すると次は必ず読み直す", () => {
			write(paths.tm, CONFLICTED);
			pinMtime(paths.tm);
			const scanner = new MdaitConflictScanner();
			assert.equal(scanner.scan(paths).total, 1);

			fs.writeFileSync(paths.tm, "y".repeat(CONFLICTED.length), "utf-8");
			pinMtime(paths.tm);
			scanner.invalidate();

			assert.equal(scanner.scan(paths).total, 0);
		});

		test("ファイルが消えても数え続けない", () => {
			write(paths.terms, CONFLICTED);
			const scanner = new MdaitConflictScanner();
			assert.equal(scanner.scan(paths).total, 1);

			fs.rmSync(paths.terms);

			assert.equal(scanner.scan(paths).total, 0);
		});
	});
});
