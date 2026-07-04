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
  filePath?: string;  // オプション: 特定ファイルのステータスのみ
}
```

**実装**:
- `StatusManager.getStatusItemTree()` から情報を取得
- `filePath` が指定されている場合、そのファイルの詳細を返す
- 指定なしの場合、`tree.aggregateProgress()` で全体サマリを返す
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
- 実行後に `StatusManager` から最新のステータスを取得して返す

**確認UI**: あり（マーカーを書き換えるため）
- タイトル: "Confirm Synchronization"
- メッセージ: "This will update translation markers in your Markdown files. Do you want to proceed?"

**実装**: [`src/lm-tools/sync-tool.ts`](../../src/lm-tools/sync-tool.ts)

### 3. Translate Tool (`mdait_translate`)

**機能**: ファイルの翻訳

**入力パラメータ**:
```typescript
interface TranslateInput {
  filePath: string;  // 翻訳対象ファイルの相対パスまたは絶対パス
}
```

**実装**:
- `filePath` からURIを解決
- ファイルがターゲットファイルか確認（`FileExplorer.getTransPairFromTarget()`）
- AI初回チェック（`AIOnboarding.checkAndShowFirstUseDialog()`）
- `transFile_CoreProc()` を呼び出して翻訳を実行
- Tool APIでは `vscode.window.withProgress` が使えないため、ダミーのprogressオブジェクトを作成
- 翻訳後に `StatusManager` でファイルステータスを更新

**確認UI**: あり（AIを使用するため）
- タイトル: "Confirm Translation"
- メッセージ: "Translate file: {filePath}?\n\nThis will translate {n} units using AI."
- 翻訳対象ユニット数を表示してユーザーの意思決定を支援

**実装**: [`src/lm-tools/translate-tool.ts`](../../src/lm-tools/translate-tool.ts)

---

## ファイル構成

```
src/lm-tools/
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

全てのツールは`try/catch`でエラーをキャッチし、`logger.error()`でログ記録後、`vscode.l10n.t()`でローカライズしたメッセージを`LanguageModelToolResult`で返します。

---

## 使用例

GitHub Copilot Chatでのコマンド例:

```
@mdaitStatus  → mdait_getStatus 呼び出し（翻訳状況を取得）
@mdaitSync    → mdait_sync 呼び出し（マーカー同期）
@mdaitTranslate README.ja.md → mdait_translate 呼び出し（ファイル翻訳）
```

---

## 今後の拡張可能性

追加ツールの候補: Term Detection、TM Commit、Validate、Search。エージェント主導のサイト全体翻訳シナリオに向けたツール拡張の設計とロードマップは [agent-orchestration.md](agent-orchestration.md) を参照。
追加手順: `src/lm-tools/`にファイル作成 → `package.json`に定義追加 → `extension.ts`で登録 → l10nリソース追加 → 本ドキュメント更新。

---

## 関連

- [architecture.md](../architecture.md) 「Tools層」参照
