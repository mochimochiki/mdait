/**
 * @file setup-doctor.ts
 * @description セットアップ診断の純粋ロジック（VS Code 非依存）。
 * 初心者が嵌まりやすい設定・ディレクトリ・APIキーの問題を静的に検出する。
 * IO（ディレクトリ存在・マーカー有無）は DoctorProbe として注入し、単体テスト可能に保つ。
 */

export type DiagnosticLevel = "error" | "warn" | "info";

/**
 * 1件の診断結果。
 * `id` はメッセージ・アクションの解決キーであり、ユーザー向け文字列化（l10n）は UI 層が担う。
 */
export interface Diagnostic {
	level: DiagnosticLevel;
	id: string;
	/** メッセージ補間用パラメータ（UI 層で `{key}` を置換） */
	params?: Record<string, string>;
}

/** 診断対象の設定スナップショット（Configuration の公開フィールドから組み立てる） */
export interface DoctorConfigSnapshot {
	transPairs: Array<{
		sourceDir: string;
		targetDir: string;
		sourceLang: string;
		targetLang: string;
	}>;
	primaryLang: string;
	aiProvider: string;
	/** openai プロバイダ利用時の apiKey 生値（解決前） */
	openaiApiKey?: string;
}

/** ファイルシステム探索の抽象（テストで差し替え可能にする） */
export interface DoctorProbe {
	/** ベースディレクトリからの相対ディレクトリが存在するか */
	dirExists(relDir: string): boolean;
	/** 相対ディレクトリ配下の Markdown ファイル数 */
	countMarkdownFiles(relDir: string): number;
	/** 相対ディレクトリ配下で mdait マーカーを含むファイル数 */
	countFilesWithMarkers(relDir: string): number;
}

/** パス比較用に末尾スラッシュ除去・区切り正規化する */
function normalizeDir(dir: string): string {
	return dir.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 2つのディレクトリが同一を指すか */
function isSamePath(a: string, b: string): boolean {
	return normalizeDir(a) === normalizeDir(b);
}

/** 一方が他方の配下（入れ子）か */
function isNested(a: string, b: string): boolean {
	const na = normalizeDir(a);
	const nb = normalizeDir(b);
	return na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

/**
 * apiKey が「リテラル直書き（環境変数参照ではない実キー）」かどうか。
 * `${env:...}` などの補間式は安全とみなす。空・未設定は false。
 * B（破壊的操作ガード）からも再利用する。
 */
export function isLiteralApiKey(apiKey: string | undefined): boolean {
	if (!apiKey) {
		return false;
	}
	const trimmed = apiKey.trim();
	if (trimmed.length === 0) {
		return false;
	}
	// ${env:OPENAI_API_KEY} や ${...} の補間式は安全
	if (/\$\{[^}]+\}/.test(trimmed)) {
		return false;
	}
	return true;
}

/** error レベルの診断が1件でもあるか（=Sync/Trans が失敗する状態か） */
export function hasBlockingError(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some((d) => d.level === "error");
}

/**
 * 設定スナップショットとファイルシステムプローブから静的診断を実行する。
 * AI プロバイダの実到達性など非同期 IO を要する確認は UI 層（doctor-command）が別途行う。
 */
export function runStaticChecks(
	config: DoctorConfigSnapshot,
	probe: DoctorProbe,
): Diagnostic[] {
	const out: Diagnostic[] = [];

	// 1. 翻訳ペアの有無
	const pairs = config.transPairs ?? [];
	if (pairs.length === 0) {
		out.push({ level: "error", id: "config.noTransPairs" });
	}

	// 2. 各ペアのディレクトリ
	for (const pair of pairs) {
		if (!pair.sourceDir) {
			out.push({ level: "error", id: "pair.noSourceDir" });
		}
		if (!pair.targetDir) {
			out.push({ level: "error", id: "pair.noTargetDir" });
		}
		if (!pair.sourceDir || !pair.targetDir) {
			continue;
		}

		if (isSamePath(pair.sourceDir, pair.targetDir)) {
			out.push({
				level: "error",
				id: "pair.sourceEqualsTarget",
				params: { dir: pair.sourceDir },
			});
		} else if (isNested(pair.sourceDir, pair.targetDir)) {
			out.push({
				level: "warn",
				id: "pair.nestedDirs",
				params: { source: pair.sourceDir, target: pair.targetDir },
			});
		}

		// sourceDir 存在チェック → 存在すればマーカー有無も確認
		if (!probe.dirExists(pair.sourceDir)) {
			out.push({
				level: "error",
				id: "pair.sourceMissing",
				params: { dir: pair.sourceDir },
			});
		} else {
			const mdCount = probe.countMarkdownFiles(pair.sourceDir);
			const markerCount = probe.countFilesWithMarkers(pair.sourceDir);
			if (mdCount > 0 && markerCount === 0) {
				// Markdown はあるがマーカーが無い → まず Sync（P2/P3）
				out.push({
					level: "info",
					id: "pair.noMarkersRunSync",
					params: { dir: pair.sourceDir },
				});
			}
		}

		// targetDir は Sync で生成され得るため、不在は情報レベル
		if (!probe.dirExists(pair.targetDir)) {
			out.push({
				level: "info",
				id: "pair.targetMissing",
				params: { dir: pair.targetDir },
			});
		}
	}

	// 3. primaryLang（必須＋意味的整合）
	if (!config.primaryLang) {
		out.push({ level: "error", id: "config.noPrimaryLang" });
	} else if (pairs.length > 0) {
		const langs = new Set<string>();
		for (const p of pairs) {
			if (p.sourceLang) {
				langs.add(p.sourceLang);
			}
			if (p.targetLang) {
				langs.add(p.targetLang);
			}
		}
		if (langs.size > 0 && !langs.has(config.primaryLang)) {
			out.push({
				level: "warn",
				id: "config.primaryLangMismatch",
				params: {
					primaryLang: config.primaryLang,
					langs: [...langs].join(", "),
				},
			});
		}
	}

	// 4. APIキー直書き（P5：漏洩注意）
	if (config.aiProvider === "openai" && isLiteralApiKey(config.openaiApiKey)) {
		out.push({ level: "warn", id: "ai.apiKeyLiteral" });
	}

	return out;
}
