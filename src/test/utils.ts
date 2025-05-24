import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * ディレクトリを再帰的に削除します。
 */
export async function removeDirRecursive(dirPath: string): Promise<void> {
	try {
		await fs.rm(dirPath, { recursive: true, force: true });
	} catch (e) {
		// 存在しない場合は無視
	}
}

/**
 * ディレクトリを再帰的にコピーします。
 */
export async function copyDirRecursive(
	src: string,
	dest: string,
): Promise<void> {
	await fs.mkdir(dest, { recursive: true });
	const entries = await fs.readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDirRecursive(srcPath, destPath);
		} else {
			await fs.copyFile(srcPath, destPath);
		}
	}
}
