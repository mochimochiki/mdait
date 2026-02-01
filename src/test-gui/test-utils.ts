/**
 * test-gui用の共通テストユーティリティ
 *
 * 各テストスイートが独立したワークスペースディレクトリを使用できるようにする。
 * これにより、テスト間の干渉を防止し、テストの安定性を向上させる。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StatusManager } from "../core/status/status-manager";
import { UnitRegistryManager } from "../core/unit-registry/unit-registry-manager";

/**
 * ディレクトリを再帰的にコピーする
 */
export function copyDirSync(src: string, dest: string): void {
	if (!existsSync(dest)) {
		mkdirSync(dest, { recursive: true });
	}
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

/**
 * テストワークスペースのベースパスを取得する
 */
export function getTestBasePaths() {
	const sampleContentDir = join(__dirname, "../../../src/test/sample-content");
	const workspaceDir = join(__dirname, "../../../src/test/workspace");
	return { sampleContentDir, workspaceDir };
}

/**
 * テスト用の独立したワークスペースディレクトリを作成する
 *
 * @param suiteId スイートの識別子（例: 'sync', 'trans'）
 * @returns ワークスペース情報
 */
export function createTestWorkspace(suiteId: string) {
	const { sampleContentDir, workspaceDir } = getTestBasePaths();
	// 固定のサブディレクトリ名を使用（ランダムではなくスイートIDベース）
	const contentDir = join(workspaceDir, `content-${suiteId}`);
	const enDir = join(contentDir, "en");
	const jaDir = join(contentDir, "ja");

	// 既存のディレクトリがあれば削除してからコピー
	if (existsSync(contentDir)) {
		rmSync(contentDir, { recursive: true, force: true });
	}
	copyDirSync(sampleContentDir, contentDir);

	return {
		workspaceDir,
		contentDir,
		enDir,
		jaDir,
		sampleContentDir,
	};
}

/**
 * テストワークスペースをクリーンアップする
 *
 * @param suiteId スイートの識別子
 */
export function cleanupTestWorkspace(suiteId: string): void {
	const { workspaceDir } = getTestBasePaths();
	const contentDir = join(workspaceDir, `content-${suiteId}`);
	if (existsSync(contentDir)) {
		rmSync(contentDir, { recursive: true, force: true });
	}
}

/**
 * .mdaitディレクトリをクリーンアップする
 * unit-registryファイルを削除し、UnitRegistryManagerをリセット
 * StatusManagerもリセットして前のテストの状態を引き継がないようにする
 */
export function resetMdaitState(): void {
	const { workspaceDir } = getTestBasePaths();
	const mdaitDir = join(workspaceDir, ".mdait");
	const unitRegistryPath = join(mdaitDir, "unit-registry");

	// unit-registryファイルを削除
	if (existsSync(unitRegistryPath)) {
		try {
			rmSync(unitRegistryPath, { force: true });
		} catch {
			// 削除できなくても続行
		}
	}

	// UnitRegistryManagerのシングルトンをリセット
	UnitRegistryManager.resetInstance();

	// StatusManagerをdisposeして前のテストの状態をクリア
	try {
		StatusManager.getInstance().dispose();
	} catch {
		// dispose済みの場合は無視
	}
}

/**
 * テスト用ワークスペースヘルパークラス
 *
 * suiteSetup/suiteTeardown で使用することで、
 * スイート全体で一貫したワークスペースを使用できる
 */
export class TestWorkspaceHelper {
	public readonly workspaceDir: string;
	public readonly contentDir: string;
	public readonly enDir: string;
	public readonly jaDir: string;
	public readonly sampleContentDir: string;

	constructor(private readonly suiteId: string) {
		const paths = createTestWorkspace(suiteId);
		this.workspaceDir = paths.workspaceDir;
		this.contentDir = paths.contentDir;
		this.enDir = paths.enDir;
		this.jaDir = paths.jaDir;
		this.sampleContentDir = paths.sampleContentDir;
	}

	/**
	 * ワークスペースをリセットする（各テストのsetupで使用）
	 */
	reset(): void {
		if (existsSync(this.contentDir)) {
			rmSync(this.contentDir, { recursive: true, force: true });
		}
		copyDirSync(this.sampleContentDir, this.contentDir);
	}

	/**
	 * ワークスペースをクリーンアップする（suiteTeardownで使用）
	 */
	cleanup(): void {
		cleanupTestWorkspace(this.suiteId);
	}
}
