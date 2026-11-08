/**
 * @file validate-command.ts
 * @description
 *   翻訳済みペアユニットに対する検証（構造チェック＋用語一貫性 term-lint＋訳し残し）のワークフロー。
 *   読取専用・AI不使用。
 *
 *   人間向けの単独コマンドは持たない（ADR-260802-02）。呼び出し口は2つ:
 *   - ✨AIレビューの前処理（`runDeterministicChecks`）— AI に投げる前に確定的な違反を洗う
 *   - `mdait_validate` ツール（エージェントのゴール判定）
 * @module commands/validate/validate-command
 */
import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { type TermLintTerm, lintUnitPair } from "../../core/term/term-lint";
import { Configuration, type TransPair } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import type { TermEntry } from "../term/term-entry";
import { TermEntry as TermEntryUtils } from "../term/term-entry";
import { TermsRepository } from "../term/terms-repository";
import { findSourceResidue, formatSourceResidueReason, residueAllowedTerms } from "../trans/source-residue";
import { TranslationChecker } from "../trans/translation-checker";

const logger = Logger.getInstance();

/** 検証の種別 */
export type ValidateCheck = "structure" | "terms" | "residue";

/** 検証違反 */
export interface ValidationViolation {
	/** ターゲットファイルパス（ワークスペース相対） */
	file: string;
	/** 訳文ユニットのハッシュ */
	unitHash: string;
	/** 検証種別 */
	check: ValidateCheck;
	/** terms: 原文に出現した用語 */
	term?: string;
	/** terms: 期待していた訳語（正規形＋variants） */
	expected?: string;
	/** structure: 実際の状態（メッセージ内に含む） */
	actual?: string;
	/** 重大度（現状は warning のみ。自動修正はしない） */
	severity: "warning";
	/** 人間可読メッセージ */
	message: string;
}

/** 検証レポート */
export interface ValidationReport {
	/** 実行した検証種別 */
	checks: ValidateCheck[];
	/** 検証したファイル数 */
	filesChecked: number;
	/** 検証したペアユニット数（翻訳済みのみ） */
	unitsChecked: number;
	/** need フラグが残っていて検証対象外だったユニット数 */
	unitsSkipped: number;
	/** 違反一覧 */
	violations: ValidationViolation[];
}

/**
 * 複数ファイルに確定的な検査（構造＋用語一貫性）をかけ、1つのレポートにまとめる。
 *
 * ✨AIレビューの前処理として使う。AI に投げる前に機械で判定できる違反を洗っておくと、
 * 同じことを LLM に有料で聞かずに済む（ADR-260802-02）。
 *
 * 1ファイルの失敗は他のファイルを巻き込まない（`validate_CoreProc` 内で握り潰される）。
 */
export async function runDeterministicChecks(files: readonly string[]): Promise<ValidationReport> {
	const merged: ValidationReport = {
		checks: ["structure", "terms", "residue"],
		filesChecked: 0,
		unitsChecked: 0,
		unitsSkipped: 0,
		violations: [],
	};
	for (const file of files) {
		try {
			const report = await validate_CoreProc(file);
			merged.filesChecked += report.filesChecked;
			merged.unitsChecked += report.unitsChecked;
			merged.unitsSkipped += report.unitsSkipped;
			merged.violations.push(...report.violations);
		} catch (error) {
			logger.warn("validate", "Deterministic check failed for file", { file, ...formatError(error) });
		}
	}
	return merged;
}

/**
 * 検証を実行する（読取専用・AI不使用）。
 *
 * 検証対象は「翻訳済みペアユニット」（from あり・need なし）のみ。
 * need が残るユニットは翻訳/レビューが先であり、検証しても意味がないためスキップする。
 *
 * @param scopePath 対象スコープ（ファイル/ディレクトリ）。省略時は全transPairのターゲット
 * @param checks 実行する検証種別（省略時は structure・terms・residue のすべて）
 */
export async function validate_CoreProc(
	scopePath: string | undefined,
	checks: ValidateCheck[] = ["structure", "terms", "residue"],
): Promise<ValidationReport> {
	const config = Configuration.getInstance();
	const fileExplorer = new FileExplorer();
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

	const report: ValidationReport = {
		checks,
		filesChecked: 0,
		unitsChecked: 0,
		unitsSkipped: 0,
		violations: [],
	};

	// スコープのターゲットMDファイルを解決
	const targetFiles = await resolveValidateTargets(scopePath, config, fileExplorer);
	if (targetFiles.length === 0) {
		return report;
	}

	// 用語集は一度だけロード（terms か residue のチェック時のみ）
	let allTerms: readonly TermEntry[] = [];
	if (checks.includes("terms") || checks.includes("residue")) {
		try {
			const repository = await TermsRepository.load(config.getTermsFilePath(), config.transPairs, config.primaryLang);
			allTerms = await repository.getAllEntries();
		} catch {
			// 用語集がない場合、terms チェックは違反0件になり、residue は仮名を許す語なしで調べる
			allTerms = [];
		}
	}

	const checker = checks.includes("structure") ? new TranslationChecker() : undefined;
	// 言語ペアごとの TermLintTerm 変換キャッシュ
	const lintTermsCache = new Map<string, TermLintTerm[]>();

	for (const targetFile of targetFiles) {
		const pair = fileExplorer.getTransPairFromTarget(targetFile, config);
		if (!pair) {
			continue;
		}
		const sourceFile = fileExplorer.getSourcePath(targetFile, pair);
		if (!sourceFile || !fs.existsSync(sourceFile)) {
			continue;
		}

		try {
			const sourceUnits = parseUnits(sourceFile, config, "source");
			const targetUnits = parseUnits(targetFile, config, "target");
			const sourceByHash = new Map<string, MdaitUnit>();
			for (const unit of sourceUnits) {
				if (unit.marker?.hash) {
					sourceByHash.set(unit.marker.hash, unit);
				}
			}

			const relFile = path.relative(workspaceRoot, targetFile).replace(/\\/g, "/");
			const residueAllowed = checks.includes("residue") ? residueAllowedTerms(allTerms, pair.targetLang) : undefined;
			let lintTerms: TermLintTerm[] | undefined;
			if (checks.includes("terms") && allTerms.length > 0) {
				const cacheKey = `${pair.sourceLang}->${pair.targetLang}`;
				lintTerms = lintTermsCache.get(cacheKey);
				if (!lintTerms) {
					lintTerms = toLintTerms(allTerms, pair);
					lintTermsCache.set(cacheKey, lintTerms);
				}
			}

			for (const unit of targetUnits) {
				if (!unit.marker?.from) {
					continue; // 独自ユニット・keep等はペア検証の対象外
				}
				if (unit.marker.need) {
					report.unitsSkipped++;
					continue; // need 残りは翻訳/レビューが先
				}
				const sourceUnit = sourceByHash.get(unit.marker.from);
				if (!sourceUnit) {
					continue;
				}
				report.unitsChecked++;

				// 構造チェック
				if (checker) {
					const result = checker.checkTranslationQuality(sourceUnit.content, unit.content);
					for (const reason of result.reasons) {
						report.violations.push({
							file: relFile,
							unitHash: unit.marker.hash,
							check: "structure",
							actual: reason.category,
							severity: "warning",
							message: reason.message,
						});
					}
				}

				// 訳し残しチェック（構造チェックとは別の関数に置く）
				if (residueAllowed) {
					report.violations.push(...checkSourceResidue(relFile, unit, pair, residueAllowed));
				}

				// 用語一貫性チェック（term-lint）
				if (lintTerms && lintTerms.length > 0) {
					const violations = lintUnitPair(sourceUnit.content, unit.content, lintTerms);
					for (const violation of violations) {
						report.violations.push({
							file: relFile,
							unitHash: unit.marker.hash,
							check: "terms",
							term: violation.term,
							expected: violation.expectedVariants.join(" / "),
							severity: "warning",
							message: `用語「${violation.term}」の期待訳語（${violation.expectedVariants.join(" / ")}）が訳文に見つかりません`,
						});
					}
				}
			}
			report.filesChecked++;
		} catch (error) {
			logger.warn("validate", "File validation error", {
				file: targetFile,
				...formatError(error),
			});
		}
	}

	return report;
}

/**
 * 訳文ユニットに原文の仮名が残っていないかを調べ、違反にして返す。
 */
function checkSourceResidue(
	relFile: string,
	unit: MdaitUnit,
	pair: TransPair,
	allowedTerms: readonly string[],
): ValidationViolation[] {
	const residue = findSourceResidue(pair.sourceLang, pair.targetLang, unit.content, allowedTerms);
	if (!residue.found || !unit.marker) {
		return [];
	}
	return [
		{
			file: relFile,
			unitHash: unit.marker.hash,
			check: "residue",
			actual: residue.fragments.join(" / "),
			severity: "warning",
			message: formatSourceResidueReason(residue.fragments),
		},
	];
}

/**
 * 用語集エントリを言語ペアの TermLintTerm に変換する（両言語が揃うエントリのみ）
 *
 * 同じ原語の行が複数あるとき（訳し分け。ADR-261108-06）は1つにまとめ、**どの意味の訳語でも
 * 正解**として扱う。どの出現がどの意味かは機械では決められないので、行ごとに照合すると、
 * 正しく訳し分けた訳文でも「使わなかった方の意味」が必ず違反になる。
 */
export function toLintTerms(terms: readonly TermEntry[], pair: TransPair): TermLintTerm[] {
	const bySource = new Map<string, { sourceVariants: string[]; accepted: string[] }>();
	for (const entry of terms) {
		const source = TermEntryUtils.getTerm(entry, pair.sourceLang);
		const expected = TermEntryUtils.getTerm(entry, pair.targetLang);
		if (!source || !expected) {
			continue;
		}
		const group = bySource.get(source) ?? { sourceVariants: [], accepted: [] };
		bySource.set(source, group);
		for (const variant of TermEntryUtils.getvariants(entry, pair.sourceLang)) {
			if (!group.sourceVariants.includes(variant)) group.sourceVariants.push(variant);
		}
		for (const accepted of [expected, ...TermEntryUtils.getvariants(entry, pair.targetLang)]) {
			if (!group.accepted.includes(accepted)) group.accepted.push(accepted);
		}
	}
	return [...bySource.entries()].map(([source, group]) => ({
		source,
		sourceVariants: group.sourceVariants,
		expected: group.accepted[0],
		expectedVariants: group.accepted.slice(1),
	}));
}

/**
 * ファイルをパースしてユニットを返す
 */
function parseUnits(
	filePath: string,
	config: Configuration,
	role: "source" | "target",
): readonly MdaitUnit[] {
	const content = fs.readFileSync(filePath, "utf-8");
	const io = resolveMarkerIO(config, filePath, role);
	return markdownParser.parse(content, config, io.provider, io.ctx).units;
}

/**
 * 検証対象のターゲットMDファイル群を解決する
 */
async function resolveValidateTargets(
	scopePath: string | undefined,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<string[]> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const configBase = config.getConfigBaseDir() ?? workspaceRoot ?? "";

	const collectFromDir = async (dir: string): Promise<string[]> => {
		const pattern = new vscode.RelativePattern(dir, "**/*.md");
		const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
		return found.map((f) => f.fsPath).filter((f) => fileExplorer.isTargetFile(f, config));
	};

	if (!scopePath) {
		const results: string[] = [];
		const seen = new Set<string>();
		for (const pair of config.transPairs) {
			const dir = path.isAbsolute(pair.targetDir) ? pair.targetDir : path.resolve(configBase, pair.targetDir);
			if (!fs.existsSync(dir)) {
				continue;
			}
			for (const file of await collectFromDir(dir)) {
				if (!seen.has(file)) {
					seen.add(file);
					results.push(file);
				}
			}
		}
		return results;
	}

	const absPath = path.isAbsolute(scopePath)
		? scopePath
		: workspaceRoot
			? path.resolve(workspaceRoot, scopePath)
			: scopePath;
	if (!fs.existsSync(absPath)) {
		return [];
	}
	if (fs.statSync(absPath).isDirectory()) {
		return collectFromDir(absPath);
	}
	return fileExplorer.isTargetFile(absPath, config) ? [absPath] : [];
}
