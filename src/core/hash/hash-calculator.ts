import * as crypto from "node:crypto";
import * as zlib from "node:zlib"; // zlib をインポート
import { normalizeText } from "./normalizer";

/**
 * ハッシュ計算処理を行うクラス
 */
export class HashCalculator {
	private algorithm: string;
	private length: number;

	/**
	 * コンストラクタ
	 * @param algorithm ハッシュアルゴリズム（デフォルト: crc32）
	 * @param length 短縮ハッシュの長さ（デフォルト: 8）
	 */
	constructor(algorithm = "crc32", length = 8) {
		this.algorithm = algorithm;
		this.length = length;
	}

	/**
	 * テキストのハッシュを計算
	 * @param text ハッシュを計算するテキスト
	 * @param normalize 正規化するかどうか（デフォルト: true）
	 * @returns 計算されたハッシュ文字列（短縮形）
	 */
	calculate(text: string, normalize = true): string {
		const processedText = normalize ? normalizeText(text) : text;

		// 空文字列の場合は特殊な値を返す
		if (processedText === "") {
			return "00000000"; // 空テキスト用の固定ハッシュ
		}

		let hash: string;
		if (this.algorithm.toLowerCase() === "crc32") {
			const crcBuffer = Buffer.from(processedText);
			const crcValue = zlib.crc32(crcBuffer);
			// 符号なし32ビット整数に変換し、16進数文字列に変換後、8桁になるよう0でパディング
			hash = (crcValue >>> 0).toString(16).padStart(8, "0");
		} else {
			hash = crypto
				.createHash(this.algorithm)
				.update(processedText)
				.digest("hex");
		}

		return hash.substring(0, this.length);
	}
}

/**
 * デフォルトのハッシュ計算処理を行うインスタンス
 */
export const defaultCalculator = new HashCalculator(); // デフォルトアルゴリズムが crc32 になる

/**
 * テキストのハッシュを計算する
 * @param text ハッシュを計算するテキスト
 * @param normalize 正規化するかどうか（デフォルト: true）
 * @returns 計算されたハッシュ文字列（短縮形）
 */
export function calculateHash(text: string, normalize = true): string {
	return defaultCalculator.calculate(text, normalize);
}
