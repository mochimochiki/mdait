import { strict as assert } from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** GC は台帳が 5MB を超えた回にしか走らない。閾値を跨ぐだけの控えを作る */
const ENTRY_COUNT = 700;
/** gzip で縮まない中身にする（縮むと閾値に届かない） */
const makeContent = (index: number): string => `${index}:${crypto.randomBytes(6000).toString("base64")}`;

const hashOf = (index: number): string => index.toString(16).padStart(8, "0");

/**
 * 台帳の掃除が走ってよい条件のテスト。
 *
 * 掃除は「渡されたハッシュ以外は誰も使っていない」と決めつけて消す操作なので、
 * 決めつけの前提が崩れている回に走らせてはいけない（docs/design/merge-resilience.md）。
 */
suite("unit-registry の掃除: 走らせてよい条件", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-registry-gc-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** 閾値を超える台帳を作って、そのパスを返す */
	async function buildLargeRegistry(): Promise<string> {
		const mgr = UnitRegistryManager.getInstance();
		for (let i = 0; i < ENTRY_COUNT; i++) {
			mgr.saveUnitRegistry(hashOf(i), makeContent(i));
		}
		await mgr.flushBuffer();
		const registryPath = path.join(tempDir, ".mdait", "unit-registry");
		assert.ok(fs.statSync(registryPath).size > 5 * 1024 * 1024, "テストの前提: 台帳が閾値を超えていない");
		return registryPath;
	}

	test("丸ごと読めた台帳では、渡されなかった控えが掃除される（対照）", async () => {
		await buildLargeRegistry();

		UnitRegistryManager.resetInstance();
		const mgr = UnitRegistryManager.getInstance();
		await mgr.garbageCollect(new Set([hashOf(0)]));

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.notEqual(await reloaded.loadUnitRegistry(hashOf(0)), null, "渡した控えまで消えている");
		assert.equal(await reloaded.loadUnitRegistry(hashOf(1)), null, "掃除が走っていない");
	});

	test("台帳を1行でも取りこぼした回は掃除を走らせない（合流の途中で消さない）", async () => {
		const registryPath = await buildLargeRegistry();
		fs.appendFileSync(registryPath, "<<<<<<< HEAD\n", "utf-8");

		UnitRegistryManager.resetInstance();
		const mgr = UnitRegistryManager.getInstance();
		await mgr.garbageCollect(new Set([hashOf(0)]));

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.notEqual(
			await reloaded.loadUnitRegistry(hashOf(1)),
			null,
			"読み取りに傷があったのに掃除が走り、控えが消えた",
		);
	});
});
