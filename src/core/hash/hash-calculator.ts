import * as crypto from "node:crypto";
import { normalizeText } from "./normalizer";

/**
 * ハッシュ計算処理を行うクラス
 */
export class HashCalculator {
	private algorithm: string;
	private length: number;

	/**
	 * コンストラクタ
	 * @param algorithm ハッシュアルゴリズム（デフォルト: sha256）
	 * @param length 短縮ハッシュの長さ（デフォルト: 8）
	 */
	constructor(algorithm = "sha256", length = 8) {
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

		const hash = crypto
			.createHash(this.algorithm)
			.update(processedText)
			.digest("hex");

		return hash.substring(0, this.length);
	}
}

/**
 * デフォルトのハッシュ計算処理を行うインスタンス
 */
export const defaultCalculator = new HashCalculator();

/**
 * テキストのハッシュを計算する
 * @param text ハッシュを計算するテキスト
 * @param normalize 正規化するかどうか（デフォルト: true）
 * @returns 計算されたハッシュ文字列（短縮形）
 */
export function calculateHash(text: string, normalize = true): string {
	return defaultCalculator.calculate(text, normalize);
}
