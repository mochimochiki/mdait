import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * ファイルをアトミックに書き込む
 * 同一ディレクトリ内の一時ファイルへ書き込んだ後にrenameすることで、
 * 書き込み途中のクラッシュや中断によるファイル破損を防ぐ
 * （いつ中断されても「旧内容の完全なファイル」か「新内容の完全なファイル」のどちらかが残る）
 *
 * 親ディレクトリが存在しない場合は作成する
 * 書き込み・rename失敗時は一時ファイルを削除して例外を再throwする
 *
 * @param filePath 書き込み先の絶対パス
 * @param data 書き込む内容
 * @param options fs.writeFileSyncに渡すオプション
 */
export function atomicWriteFileSync(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options?: fs.WriteFileOptions,
): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });

	// 既存ファイルのパーミッションを引き継ぐ（renameはumask由来のmodeになるため）
	let existingMode: number | undefined;
	try {
		existingMode = fs.statSync(filePath).mode;
	} catch {
		// 新規ファイルの場合はデフォルトのmodeを使用
	}

	const tmpPath = path.join(
		dir,
		`.tmp-${path.basename(filePath)}-${crypto.randomBytes(6).toString("hex")}`,
	);

	try {
		fs.writeFileSync(tmpPath, data, options);
		if (existingMode !== undefined) {
			fs.chmodSync(tmpPath, existingMode);
		}
		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// 一時ファイルの掃除失敗は無視（元の例外を優先）
		}
		throw error;
	}
}
