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
- `detail:true` のとき、needのあるファイルのみの内訳一覧を `data.files` に格納（出力爆発防止）
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
└── translate-tool.ts     # 翻訳ツール
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
```

---

## エラーハンドリング

全てのツールは`try/catch`でエラーをキャッチし、`logger.error()`でログ記録後、`ok:false` ＋ `error.code`/`error.message` のエンベロープで返します。`summary` は `vscode.l10n.t()` でローカライズします。エラー時も可能なら `nextActions` でリカバリ手順（再sync・再実行など）を案内します。

---

## 使用例

GitHub Copilot Chatでのコマンド例:

```
#mdaitStatus  → mdait_getStatus 呼び出し（翻訳状況を取得）
#mdaitSync    → mdait_sync 呼び出し（マーカー同期）
#mdaitTranslate README.ja.md → mdait_translate 呼び出し（ファイル翻訳）
```

---

## 今後の拡張可能性

追加ツールの候補: Term Detection、TM Commit、Validate、Search。エージェント主導のサイト全体翻訳シナリオに向けたツール拡張の設計とロードマップは [agent-orchestration.md](agent-orchestration.md) を参照。
追加手順: `src/lm-tools/`にファイル作成 → `package.json`に定義追加 → `extension.ts`で登録 → l10nリソース追加 → 本ドキュメント更新。

---

## 関連

- [architecture.md](../architecture.md) 「Tools層」参照
