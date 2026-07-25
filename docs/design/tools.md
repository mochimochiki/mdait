# Tools

> [architecture](../architecture.md) > **Tools**

## このドキュメントの責務

Tools層は、GitHub Copilot ChatなどのLanguageModel向けにmdaitの機能を公開するためのAPI層です。VS CodeのLanguageModelTool APIを使用して、mdaitの主要機能をCopilot Chatから呼び出せるようにします。

---

## 設計原則

1. **既存機能の再利用**: Commands層やCore層の既存機能を薄くラップし、新しいビジネスロジックは持たない
2. **読み取り専用優先**: 副作用のある操作には適切な確認UIを提供
3. **エラーハンドリング**: 全てのエラーをキャッチし、ユーザーフレンドリーなメッセージを返す
4. **i18n対応**: `vscode.l10n.t()` を使用して国際化対応
5. **観測範囲は人間と同じ**: パスを指定しない全体集計は、ステータスツリーと同じく**選択中の transPair のみ**を対象とする（範囲の算出は `getSelectedScopeFiles` に集約。ADR-260724-01）。sync・trans が選択中のペアだけを処理するため、集計だけが全ペアを数えると「誰も処理しない件数」を報告することになる。パスを明示指定された場合はその指定を尊重し、絞り込まない

**設計意図**: 既存のCommands/Core層の薄いラッパーとして設計することで、Copilot Chat連携機能の追加によるビジネスロジックの二重管理を防ぎます。

例外として、`nextActions`（推奨次アクション）の生成ロジックはlm-tools層に置きます。これはビジネスロジックではなく案内文の生成であり、エージェント・オーケストレーション（[agent-orchestration.md](agent-orchestration.md)）のための誘導装置です。

### 共通エンベロープ（構造化出力）

全ツールは `LanguageModelTextPart` に**JSON文字列**を返します。共通エンベロープ:

```jsonc
{
  "schemaVersion": 1,        // 出力スキーマのバージョン。破壊的変更時にインクリメント
  "ok": true,                // 実行自体の成否
  "summary": "…",            // 人間向け1行サマリ（l10n経由）
  "data": { … },             // ツール固有の構造化データ
  "nextActions": ["…"],      // 推奨される次アクション（英語固定文言・エージェント向け）
  "error": { "code": "…", "message": "…" }  // ok:false のとき
}
```

実装: [`src/lm-tools/envelope.ts`](../../src/lm-tools/envelope.ts)（型とシリアライザ）、[`src/lm-tools/next-actions.ts`](../../src/lm-tools/next-actions.ts)（状態→推奨アクション対応表）、[`src/lm-tools/status-data.ts`](../../src/lm-tools/status-data.ts)（need内訳集計）。いずれもVS Code非依存・単体テスト対象。

**エンベロープはエージェントとの契約**です。フィールドの削除・意味変更は `schemaVersion` のインクリメントと全ツール一斉更新を伴います。`data` の中身はツールごとに自由です。

---

## LanguageModelTool APIの基本

VS CodeのLanguageModelTool APIは、拡張機能の機能をGitHub Copilot Chatなどから呼び出せるようにするAPIです。

### Tool実行の流れ

1. **Tool呼び出し**: Copilot Chatがツールを選択し、入力パラメータを決定
2. **prepareInvocation()**: ツール実行前の確認UIを提供（オプショナル）
3. **ユーザー承認**: 確認メッセージが表示され、ユーザーが承認/拒否
4. **invoke()**: 実際のツール処理を実行
5. **結果返却**: `LanguageModelToolResult`をCopilot Chatに返す

### 確認UIのベストプラクティス

- **読み取り専用の操作**: 確認不要（`prepareInvocation()`は簡潔なメッセージのみ）
- **ファイル変更を伴う操作**: 確認メッセージで変更内容を明示
- **AIを使用する操作**: コスト・時間がかかることを伝え、対象ユニット数などの具体情報を含めて確認

**設計意図**: `prepareInvocation()`での確認UIにより、AI使用や破壊的操作をユーザーが意図して承認したことを保証します。

---

## アーキテクチャ

```
UI層 → Commands層 → Core層 → Utils層
              ↓
           API層
Tools層 ─────→ Commands層 / Core層
  ↑
GitHub Copilot
```

Tools層は既存のCommands層やCore層の機能を呼び出し、結果をLanguageModelToolResultとして返します。

---

## 実装ツール一覧

### 1. Get Status Tool (`mdait_getStatus`)

**機能**: 翻訳ステータスの取得

**入力パラメータ**:
```typescript
interface GetStatusInput {
  path?: string;    // オプション: ファイルまたはディレクトリでスコープ指定（旧filePathも受理）
  detail?: boolean; // true でファイル別のneed内訳を含める
}
```

**実装**:
- `StatusManager.getStatusItemTree()` から情報を取得
- `data` に全体集計（総/翻訳済/エラーユニット数、needフラグ内訳）を格納
- パス未指定時の集計対象は選択中の transPair のみ。summary のスコープラベルに対象言語を明示する（例: `workspace (targets: ja)`）
- `detail:true` のとき、needのあるファイルのみの内訳一覧を `data.files` に格納（出力爆発防止）。各ファイルには need のあるユニットの一覧 `units: [{hash, title?, need}]` を含める（need なしユニットは含めない・isolate は含める・1ファイル上限50件、超過時 `unitsTruncated: true`）。エージェントはこの hash を `mdait_resolve` の `unitHashes` にそのまま渡せる
- StatusManagerが初期化されていない場合は `buildStatusItemTree()` を実行

**確認UI**: なし（読み取り専用）

**実装**: [`src/lm-tools/get-status-tool.ts`](../../src/lm-tools/get-status-tool.ts)

### 2. Sync Tool (`mdait_sync`)

**機能**: 翻訳マーカーの同期

**入力パラメータ**:
```typescript
type SyncInput = Record<string, never>;  // パラメータなし
```

**実装**:
- `syncCommand()` を呼び出して同期を実行
- `SyncResult`（ファイル数・追加/変更/削除/改訂必要ユニット数）を `data` に構造化
- 同期後の全体ステータス内訳を `data.status` に格納

**確認UI**: あり（マーカーを書き換えるため）
- タイトル: "Confirm Synchronization"
- メッセージ: "This will update translation markers in your Markdown files. Do you want to proceed?"

**実装**: [`src/lm-tools/sync-tool.ts`](../../src/lm-tools/sync-tool.ts)

### 3. Translate Tool (`mdait_translate`)

**機能**: ファイル/ディレクトリの翻訳

**入力パラメータ**:
```typescript
interface TranslateInput {
  path?: string;     // 翻訳対象ファイルまたはディレクトリのパス（旧filePathも受理）
}
```

**実装**:
- パスを絶対パスに解決し、ファイル/ディレクトリを判定
- ディレクトリの場合、配下の翻訳対象ファイルを列挙（`FileExplorer.buildExtensionGlob` + `findFiles`）し、非ターゲットはスキップ件数として報告
- AI初回チェック（`AIOnboarding.checkAndShowFirstUseDialog()`）
- 各ファイルに `transFile_CoreProc()` を順次実行（`CancellationToken` を配線。キャンセル時は処理済み件数を返し、同じ呼び出しの再実行で残りを処理できる）
- `data` にファイルごとの成功/失敗・失敗原因、スコープ内の残need内訳を格納

**確認UI**: あり（AIを使用するため）
- スコープ単位で1回。ディレクトリの場合は対象ファイル数・ユニット総数を表示
- メッセージ例: "Translate directory: {path}?\n\nThis will translate {n} units across {m} files using AI."

**実装**: [`src/lm-tools/translate-tool.ts`](../../src/lm-tools/translate-tool.ts)

### 4. Term Tool (`mdait_term`)

**機能**: 用語集の検出・展開

**入力パラメータ**:
```typescript
interface TermInput {
  action: "detect" | "expand";
  path?: string;  // ファイル/ディレクトリでスコープ指定。省略時は全transPair
}
```

**実装**:
- `detect`: `UnitPairCollector` でソース・ターゲットペアを収集し `detectTerm_CoreProc` を実行
- `expand`: `expandTerm_CoreProc` を実行（path指定時はソースファイルフィルタ）
- path はソース側・ターゲット側どちらのパスでも受理し、ソースファイル群へ正規化する
- `data`: transPairごとの新規/展開用語数と実行後の未展開残数、detect時は追加用語一覧（上限100件）

**確認UI**: あり（AIを使用し terms ファイルを書き換えるため）

**実装**: [`src/lm-tools/term-tool.ts`](../../src/lm-tools/term-tool.ts)

### 5. TM Tool (`mdait_tm`)

**機能**: 翻訳メモリのコミット・最適化

**入力パラメータ**:
```typescript
interface TmInput {
  action: "commit" | "optimize";
  path?: string;  // ターゲットファイル/ディレクトリ。省略時は全transPair（commitのみ）
}
```

**実装**:
- `commit`: ターゲットMDファイルを列挙し `executeTmCommitForFile` を実行
- `optimize`: `tmOptimizeCommand` を実行（AI不使用・重み再計算）
- `data`: 新規/更新TU数と**スキップ理由内訳**（`commit-filter.ts` の `classifyTmSkipReason` による need別・from欠落の集計）。エージェントが「なぜコミットされないか」を診断し、`nextActions` が「先に translate / review解消」を案内する

**確認UI**: あり（commit: AI使用＋tmx書換 / optimize: tmx書換）

**実装**: [`src/lm-tools/tm-tool.ts`](../../src/lm-tools/tm-tool.ts)

### 6. Validate Tool (`mdait_validate`)

**機能**: 翻訳済みペアユニットの検証（構造チェック＋用語一貫性 term-lint）

**入力パラメータ**:
```typescript
interface ValidateInput {
  path?: string;                          // ターゲットファイル/ディレクトリ。省略時は全transPair
  checks?: ("structure" | "terms")[];     // 省略時は両方
}
```

**実装**:
- `validate_CoreProc`（`src/commands/validate/validate-command.ts`）に委譲
- `structure`: 既存 `TranslationChecker` による Markdown 構造カウント比較
- `terms`: `src/core/term/term-lint.ts` の機械照合（AI不使用・保守的閾値・コードブロック/インラインコード除外）
- 検証対象は「翻訳済み」（from あり・need なし）ユニットのみ。need 残りはスキップ件数として報告
- 違反は警告であり自動修正しない。`nextActions` で「訳文を直す／variants に追加する」の二択を提示

**確認UI**: なし（読取専用・AI不使用。ループ内で何度呼んでも副作用ゼロ）

**実装**: [`src/lm-tools/validate-tool.ts`](../../src/lm-tools/validate-tool.ts)

### 7. AI Review Tool (`mdait_aiReview`)

**機能**: adopt 済みペア（from + need:review）のAI翻訳レビュー（トリアージ）

**入力パラメータ**:
```typescript
interface AiReviewInput {
  path?: string;    // ターゲットファイル/ディレクトリ。省略時は全transPair
  dryRun?: boolean; // true でマーカー無変更のレポートのみ
  mode?: "pending" | "audit"; // 既定 "pending"。"audit" は確定済みペア（fromあり・needなし）も監査（報告のみ・マーカー不変）
}
```

**実装**:
- `executeAiReviewForFiles`（`src/commands/ai-review/review-command.ts`）に委譲
- verdict `{match, mismatch, partial, uncertain}` を判定し、高確信 match の `need:review` を自動解除（`aiReview` 設定で制御、ADR-260704-07）
- `data`: verdict別ユニット集計と **escalations 一覧**（file/unitHash/title/verdict/confidence/reason/issues、上限50件）。`nextActions` が mismatch→構造修正+再sync / partial→再翻訳 / approved→tm.commit を案内する
- 冪等: 承認済みユニットは次回実行で列挙されない

**確認UI**: あり（AI使用＋マーカー書換。dryRun でもAI使用のため確認あり）

**実装**: [`src/lm-tools/ai-review-tool.ts`](../../src/lm-tools/ai-review-tool.ts)、設計: [command_ai-review.md](command_ai-review.md)

### 8. Adopt Tool (`mdait_adopt`)

**機能**: 既存対訳サイトの取り込みウィザード（`sync(adopt+align)` → AI翻訳レビュー →（オプション）用語集構築 → TM構築）

**入力パラメータ**:
```typescript
interface AdoptInput {
  dryRun?: boolean;        // true でレビュー段のマーカー無変更＋用語集/TM段スキップ（adopt段のマーカー更新は行う）
  buildGlossary?: boolean; // true で用語集構築段（term.detect → term.expand）も実行
  buildTm?: boolean;       // true でTM構築段（tm.commit）も実行
}
```

**実装**:
- `executeAdopt`（`src/commands/adopt/adopt-core.ts`）に委譲する薄い合成コマンド
- `data`: sync段の集計（adopted/alignCorrections/added/deleted/kept/orphanReviewed）、レビュー段のverdict別集計、オプション段のterm/tm集計、`stageErrors`、escalations一覧（上限50件）、実行後ステータス
- 冪等: 管理済みサイトへの再実行は採用0件・補正0件・レビュー対象0件を報告する

**確認UI**: あり（AI使用＋マーカー・terms・tmx書換）

**実装**: [`src/lm-tools/adopt-tool.ts`](../../src/lm-tools/adopt-tool.ts)、設計: [command_adopt.md](command_adopt.md)

### 9. Resolve Tool (`mdait_resolve`)

**機能**: need フラグの裁定。StatusTree/CodeLens の判断アクション（Mark as Reviewed・Keep/Delete Unit・Mark as Isolated/Un-isolate、UX-R1: [ux.md](../ux.md) §8）のLM Tool版で、エージェントがレビュー承認・削除確認・isolate宣言/解除をマーカー手編集なしで完了するための手段。`action` パラメータで3つの操作系統を切り替える（ADR-260712-03）

**入力パラメータ**:
```typescript
interface ResolveInput {
  path: string;          // 対象ファイル（相対/絶対）。ディレクトリは不可
  action?: "resolve" | "declare-isolate" | "delete"; // 省略時 "resolve"
  unitHashes?: string[]; // 対象ユニットのhash。
                         // resolve: 省略時はファイル内のneedsフィルタ一致全ユニット
                         // declare-isolate / delete: 必須（bulk操作による誤爆を防ぐ安全弁）
  needs?: string[];      // action:"resolve" のみ。解決対象のneed種別。省略時は ["review", "verify-deletion"]。
                         // translate/revise の解決は明示指定時のみ（"revise" は revise@{oldhash} にも一致）。
                         // "isolate" を指定すると isolate 宣言の解除（undeclare）になる
}
```

**実装（action別）**:
- **`resolve`（既定）**: `resolveNeedForFile`（`src/commands/markers/resolve-need.ts`）に委譲。マーカー変異は `removeNeedTag()` のみで **hash / from / 本文には一切触れない**。`data`: `resolved: [{hash, title?, need}]`・`skipped: [{hash, reason}]`（reason: `not-found` / `already-resolved` / `need-not-selected`）・解決後の `remainingNeeds` 内訳
- **`declare-isolate`**: `declareIsolateForFile`（`src/commands/markers/declare-isolate.ts`）に委譲。指定ユニットに `need:isolate` を設定する（凍結。以後 sync は revise を伝播しない）。既に何らかの need が付いているユニットはスキップする（安全弁）。`data`: `declared: [{hash, title?}]`・`skipped: [{hash, reason}]`（reason: `not-found` / `need-already-set`）
- **`delete`**: `deleteUnitFromFile`（`src/commands/markers/delete-unit.ts`）に委譲。指定ユニットをドキュメントから完全に除去する（hash/fromの書き換えではなくユニット自体の削除）。`need:verify-deletion` 以外は削除不可（安全弁）。external モードでは unit-state ストアの order を詰め直す。`data`: `deleted: [{hash, title?}]`・`skipped: [{hash, reason}]`（reason: `not-found` / `not-verify-deletion`）
- 3系統とも ai-review の `review-core.ts` と同じ書換経路（`resolveMarkerIO` 経由の parse/stringify ＋ `FileMutex` 排他）に乗るため、embedded / external 両モードで同じ意味論になる。マーカー境界はパーサーに委譲するのでコードブロック内のサンプルマーカーには誤マッチしない
- 冪等: 同入力の2回目は対象0件（`resolve`/`declare-isolate` の unitHashes 指定時は該当 reason でスキップ、`delete` は `not-found`）

**確認UI**: あり（AI不使用だがマーカー・本文書換のため。action別に対象件数を提示。`delete` は「mdaitではやり直せない・git復旧可能」の注記付き）

**実装**: [`src/lm-tools/resolve-tool.ts`](../../src/lm-tools/resolve-tool.ts)

---

## ファイル構成

```
src/lm-tools/
├── envelope.ts           # 共通エンベロープ（型・シリアライザ、VS Code非依存）
├── status-data.ts        # need内訳集計（VS Code非依存）
├── next-actions.ts       # 状態→推奨アクション対応表（VS Code非依存）
├── tool-result.ts        # エンベロープ→LanguageModelToolResult 変換
├── get-status-tool.ts    # ステータス取得ツール
├── sync-tool.ts          # 同期ツール
├── translate-tool.ts     # 翻訳ツール
├── term-tool.ts          # 用語集ツール（detect/expand）
├── tm-tool.ts            # 翻訳メモリツール（commit/optimize）
├── validate-tool.ts      # 検証ツール（structure/terms、読取専用）
├── ai-review-tool.ts     # AI翻訳レビューツール（need:reviewのトリアージ）
├── adopt-tool.ts         # 既存翻訳の取り込みウィザードツール（mdait_adopt・command_adopt.md）
└── resolve-tool.ts       # need裁定ツール（resolve除去・declare-isolate宣言・delete削除）
```

---

## 登録方法

`package.json`の`contributes.languageModelTools`にツール定義を追加し、`extension.ts`の`activate()`で登録する。

**package.json（抜粋）**:
```json
{
  "name": "mdait_getStatus",
  "displayName": "mdait: Get Translation Status",
  "toolReferenceName": "mdaitStatus",
  "modelDescription": "Get the current translation status...",
  "canBeReferencedInPrompt": true,
  "tags": ["mdait", "translation", "status"],
  "inputSchema": { ... }
}
```

**extension.ts（抜粋）**:
```typescript
const getStatusToolDisposable = vscode.lm.registerTool("mdait_getStatus", new MdaitGetStatusTool());
const syncToolDisposable = vscode.lm.registerTool("mdait_sync", new MdaitSyncTool());
const translateToolDisposable = vscode.lm.registerTool("mdait_translate", new MdaitTranslateTool());
const termToolDisposable = vscode.lm.registerTool("mdait_term", new MdaitTermTool());
const tmToolDisposable = vscode.lm.registerTool("mdait_tm", new MdaitTmTool());
const validateToolDisposable = vscode.lm.registerTool("mdait_validate", new MdaitValidateTool());
const aiReviewToolDisposable = vscode.lm.registerTool("mdait_aiReview", new MdaitAiReviewTool());
const adoptToolDisposable = vscode.lm.registerTool("mdait_adopt", new MdaitAdoptTool());
const resolveToolDisposable = vscode.lm.registerTool("mdait_resolve", new MdaitResolveTool());
```

登録した Disposable はすべて `context.subscriptions` に追加する。

---

## エラーハンドリング

全てのツールは`try/catch`でエラーをキャッチし、`logger.error()`でログ記録後、`ok:false` ＋ `error.code`/`error.message` のエンベロープで返します。`summary` は `vscode.l10n.t()` でローカライズします。エラー時も可能なら `nextActions` でリカバリ手順（再sync・再実行など）を案内します。

---

## 使用例

GitHub Copilot Chatでのコマンド例:

```
#mdaitStatus  → mdait_getStatus 呼び出し（翻訳状況を取得）
#mdaitSync    → mdait_sync 呼び出し（マーカー同期）
#mdaitTranslate docs/en → mdait_translate 呼び出し（ファイル/ディレクトリ翻訳）
#mdaitTerm    → mdait_term 呼び出し（用語検出・展開）
#mdaitTm      → mdait_tm 呼び出し（TMコミット・最適化）
#mdaitValidate → mdait_validate 呼び出し（構造・用語一貫性の検証）
#mdaitAiReview → mdait_aiReview 呼び出し（adopt済みペアのAIトリアージ）
#mdaitAdopt   → mdait_adopt 呼び出し（既存対訳の取り込みウィザード）
#mdaitResolve → mdait_resolve 呼び出し（needの裁定＝レビュー承認・削除確認の完了/削除・isolate宣言/解除）
```

---

## 今後の拡張可能性

追加ツールの候補: Search。エージェント主導のサイト全体翻訳シナリオに向けたツール拡張の設計とロードマップは [agent-orchestration.md](agent-orchestration.md) を参照。
追加手順: `src/lm-tools/`にファイル作成 → `package.json`に定義追加 → `extension.ts`で登録 → l10nリソース追加 → 本ドキュメント更新。

---

## 関連

- [architecture.md](../architecture.md) 「Tools層」参照
