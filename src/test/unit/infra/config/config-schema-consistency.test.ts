/**
 * @file config-schema-consistency.test.ts
 * @description
 *   設定スキーマ（assets/schemas/mdait-config.schema.json）とコード実装の整合を固定する契約テスト。
 *   「宣言と実体の齟齬」の再発防止:
 *   - スキーマの default とコードの既定値の食い違い（設定UIが表示する既定値と実挙動のズレ）
 *   - 消費者のいない設定キー（宣言だけの死に設定。かつての trans.markdown.skipCodeBlocks）
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";

/** リポジトリルート（out/test/unit/infra/config から5階層上） */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const schemaPath = path.join(repoRoot, "assets", "schemas", "mdait-config.schema.json");

interface SchemaNode {
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	default?: unknown;
	[key: string]: unknown;
}

function loadSchema(): SchemaNode {
	return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as SchemaNode;
}

suite("設定スキーマとコード実装の整合（契約テスト）", () => {
	suite("既定値の同値性", () => {
		test("スキーマの default とConfigurationの既定値が一致する", () => {
			Configuration.dispose();
			const config = Configuration.getInstance();
			const schema = loadSchema();
			const props = schema.properties ?? {};

			const defaultOf = (dottedPath: string): unknown => {
				let node: SchemaNode | undefined = { properties: props };
				for (const segment of dottedPath.split(".")) {
					node = node?.properties?.[segment];
				}
				assert.ok(node, `スキーマに ${dottedPath} が存在すること`);
				assert.ok("default" in node, `スキーマの ${dottedPath} に default が定義されていること`);
				return node.default;
			};

			// 設定UI（スキーマ駆動）が「既定値」として表示する値と、コードの実挙動を一致させる。
			// ここが食い違うと、設定エディタのリセットボタンが実際の既定と別の値を書く。
			const expectations: Array<[string, unknown]> = [
				["ignoredPatterns", config.ignoredPatterns],
				["markers.mode", config.markers.mode],
				["ai.provider", config.ai.provider],
				["ai.vendor", config.ai.vendor],
				["ai.model", config.ai.model],
				["ai.ollama.endpoint", config.ai.ollama?.endpoint],
				["ai.ollama.model", config.ai.ollama?.model],
				["ai.debug.enableStatsLogging", config.ai.debug?.enableStatsLogging],
				["ai.debug.logPromptAndResponse", config.ai.debug?.logPromptAndResponse],
				["trans.frontmatter.keys", config.trans.frontmatter.keys],
				["trans.contextSize", config.trans.contextSize],
				["trans.retryLimit", config.trans.retryLimit],
				["trans.maxFileSize", config.trans.maxFileSize],
				["trans.concurrency", config.trans.concurrency],
				["trans.maxUnitsPerRun", config.trans.maxUnitsPerRun],
				["terms.filename", config.terms.filename],
				["tm.enabled", config.tm.enabled],
				["tm.maxReferences", config.tm.maxReferences],
				["tm.retryLimit", config.tm.retryLimit],
				["tm.minQueryLength", config.tm.minQueryLength],
				["aiReview.autoApprove", config.aiReview.autoApprove],
				["aiReview.batchSize", config.aiReview.batchSize],
				["sync.level", config.sync.level],
				["sync.autoDelete", config.sync.autoDelete],
				["sync.autoSyncOnSave", config.sync.autoSyncOnSave],
			];

			for (const [dottedPath, codeValue] of expectations) {
				assert.deepStrictEqual(
					codeValue,
					defaultOf(dottedPath),
					`${dottedPath}: コードの既定値とスキーマの default が一致すること`,
				);
			}
		});
	});

	suite("設定キーの消費者存在", () => {
		// Configuration 内部だけで消費されるキー（パス解決・後方互換マッピング等）。
		// ここに足すときは「configuration.ts のどのメソッドが消費するか」を書くこと。
		const CONSUMED_INSIDE_CONFIGURATION: Record<string, string> = {
			filename: "Configuration.getTermsFilePath() が用語集パスの構築に使用",
			orphanTargetPolicy: "Configuration.getOrphanTargetPolicy() が autoDelete との後方互換解決に使用",
		};

		/** リーフキーを dotted path（例: tm.retryLimit）で収集する。同名リーフの階層衝突を区別するため */
		function collectLeafPaths(node: SchemaNode, prefix: string, paths: string[]): void {
			if (node.properties) {
				for (const [key, child] of Object.entries(node.properties)) {
					const childPath = prefix ? `${prefix}.${key}` : key;
					if (child.properties || child.items?.properties) {
						collectLeafPaths(child, childPath, paths);
						if (child.items?.properties) {
							collectLeafPaths(child.items, childPath, paths);
						}
					} else {
						paths.push(childPath);
					}
				}
			}
		}

		function collectTsFiles(dir: string, out: string[]): void {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "test" || entry.name === "node_modules") {
						continue;
					}
					collectTsFiles(full, out);
				} else if (entry.name.endsWith(".ts")) {
					out.push(full);
				}
			}
		}

		test("スキーマの全設定キーに消費者が存在する（宣言だけの死に設定を作らない）", () => {
			const schema = loadSchema();
			const leafPaths: string[] = [];
			collectLeafPaths(schema, "", leafPaths);
			assert.ok(leafPaths.length > 20, "スキーマから設定キーを収集できていること");

			// 宣言・解説だけの場所（型定義/読込/設定UI解説）を除いた本体コードを検索対象にする。
			// キー名の単純一致なので汎用名は偽陰性になりうるが、完全に死んだキー
			// （どのモジュールも名前すら参照しないキー）は必ず検出できる。
			const files: string[] = [];
			collectTsFiles(path.join(repoRoot, "src"), files);
			const searchable = files.filter(
				(f) => !f.endsWith(`infra${path.sep}config${path.sep}configuration.ts`) && !f.endsWith("settings-doc.ts"),
			);
			const contents = searchable.map((f) => fs.readFileSync(f, "utf-8"));

			// 同名リーフが複数階層にある場合（例: trans.retryLimit と tm.retryLimit）、
			// リーフ名の出現だけでは片方が完全に死んでいても検出できない。
			// 曖昧なリーフ名は「親セグメントと同一ファイル内で共起する」ことまで要求する。
			// （プロパティアクセスの形は分割代入等で崩れるため、文字列レベルの共起で近似する）
			const leafCount = new Map<string, number>();
			for (const dotted of leafPaths) {
				const leaf = dotted.split(".").pop() ?? dotted;
				leafCount.set(leaf, (leafCount.get(leaf) ?? 0) + 1);
			}

			const dead: string[] = [];
			for (const dotted of leafPaths) {
				const segments = dotted.split(".");
				const leaf = segments[segments.length - 1];
				if (leaf in CONSUMED_INSIDE_CONFIGURATION) {
					continue;
				}
				const parent = segments.length > 1 ? segments[segments.length - 2] : undefined;
				const ambiguous = (leafCount.get(leaf) ?? 0) > 1;
				const consumed = contents.some((content) => {
					if (!content.includes(leaf)) {
						return false;
					}
					return !ambiguous || !parent || content.includes(parent);
				});
				if (!consumed) {
					dead.push(dotted);
				}
			}
			assert.deepStrictEqual(
				dead,
				[],
				`消費者が見つからない設定キー: ${dead.join(", ")}。実装するか、スキーマ・テンプレート・設定UI・ドキュメントから削除すること`,
			);
		});
	});
});
