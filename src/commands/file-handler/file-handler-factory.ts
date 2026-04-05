import * as path from "node:path";
import type { FileHandler } from "./file-handler";
import { MdFileHandler } from "./md-file-handler";
import { PlainFileHandler } from "./plain-file-handler";

/**
 * ファイルパスの拡張子に基づいて適切なFileHandlerを返す。
 * ファイルタイプ分岐の唯一の集約点。
 */
export function getFileHandler(filePath: string): FileHandler {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") {
		return new MdFileHandler();
	}
	return new PlainFileHandler();
}
