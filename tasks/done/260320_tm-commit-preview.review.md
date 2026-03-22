# レビューレポート: tm-commit 完了後の登録内容プレビュー

**日時:** 2026-03-20  
**対象チケット:** `tasks/260320_tm-commit-preview.md`

---

## サマリ

**全体評価:** ⭐⭐⭐⭐ (4/5)  
**結論:** ✅承認  
**指摘件数:** 🔴[重大: 0件](#重大) 🟠[優先: 0件](#優先) 🟡[推奨: 2件](#推奨) 🟢[任意: 1件](#任意)

**最重要論点:**  
設計との整合性は高く、型安全性・既存機能への影響・テスト充足性いずれも問題なし。`context.subscriptions` 登録も正しい。`TmResultContentProvider` の `private constructor` 未定義と EventEmitter 未 dispose の 2 点がプロジェクト規約（`StatusManager` の先例）と不一致で推奨修正。

**変更:**
- [src/commands/tm/commit-processor.ts](../src/commands/tm/commit-processor.ts#L28): `TmResultItem` 型追加、`TmCommitUnitResult`/`TmCommitResult` に `newItems`/`updatedItems` フィールド追加
- [src/commands/tm/tm-result-provider.ts](../src/commands/tm/tm-result-provider.ts#L1): 新規作成 — `TmResultContentProvider` シングルトン + `generateContent` 純粋関数
- [src/commands/tm/command-commit.ts](../src/commands/tm/command-commit.ts#L562): `showTmCommitPreview()` 追加、ファイル・ディレクトリ両エントリーポイントに呼び出し追加
- [src/extension.ts](../src/extension.ts#L197): `TmResultContentProvider` を scheme 登録 + `context.subscriptions` に追加
- [src/test/commands/tm/tm-result-provider.test.ts](../src/test/commands/tm/tm-result-provider.test.ts#L1): `generateContent` ユニットテスト 5 件追加

---

## 🟡推奨 (2件)

### 1. `TmResultContentProvider` のコンストラクタが `private` でない

**場所:**
- [ ] [tm-result-provider.ts](../src/commands/tm/tm-result-provider.ts#L19) — クラス定義（コンストラクタが省略、暗黙 public）

**問題:**  
プロジェクト内の他シングルトン（`Logger` L102、`StatusManager` L41）はいずれも `private constructor()` を宣言し、外部からの直接インスタンス化を防いでいる。`TmResultContentProvider` だけコンストラクタが明示されておらず、既存規約と不一致。複数インスタンスが誤って生成された場合、`latestContent` の不整合が生じる。

**提案:**
```ts
private constructor() {}
```
をクラス内に追加する。

---

### 2. `_onDidChange` EventEmitter が `dispose()` されない

**場所:**
- [ ] [tm-result-provider.ts](../src/commands/tm/tm-result-provider.ts#L22) — `_onDidChange` フィールド
- [ ] [extension.ts](../src/extension.ts#L484) — `context.subscriptions.push(tmResultProviderDisposable)` — providerDisposableはスキーム登録解除のみ

**問題:**  
`tmResultProviderDisposable`（`workspace.registerTextDocumentContentProvider` の戻り値）は `context.subscriptions` に正しく追加されているが、これが dispose されてもスキーム登録が解除されるだけで、`TmResultContentProvider` シングルトン自身の `_onDidChange` EventEmitter は dispose されない。`StatusManager` は同様の EventEmitter に対して `dispose()` メソッドで `this._onStatusTreeChanged.dispose()` を呼んでおり、プロジェクトの先例と不一致になっている。

拡張機能の非活性化時にプロセスはほぼ終了するため実害は薄いが、テスト環境でのホットリロードや将来の拡張で問題になる可能性がある。

**提案:**  
`dispose()` メソッドを追加し、`extension.ts` の `context.subscriptions` に登録する:

```ts
// tm-result-provider.ts
dispose(): void {
    this._onDidChange.dispose();
}
```

```ts
// extension.ts — 既存の tmResultProviderDisposable 登録はそのままにし、追加で:
context.subscriptions.push(TmResultContentProvider.getInstance());
// または tmResultProviderDisposable と同じ push ブロックに追加
```

---

## 🟢任意 (1件)

### 3. `generateContent` — `"` を含む文への対応

**場所:**
- [ ] [tm-result-provider.ts](../src/commands/tm/tm-result-provider.ts#L67) — `[NEW] "${item.primary}" → "${item.local}"`

**問題:**  
`item.primary` や `item.local` が `"` を含む場合（例: `He said "hello".`）、出力が `[NEW] "He said "hello"." → "..."` となり視覚的に紛らわしい。ただし、このドキュメントはログ的な性質でありユーザーが編集するものではないため、機能的な問題はない。

**提案（任意）:**  
表示形式を `[NEW] «He said "hello".» → «...»` に変更するか、または何も変更しないことを選択してもよい。優先度は低い。

---

## 📊 全体整合性

### ワークスペース全体の整合性

**Core:** `TmResultItem` は `commit-processor.ts` に定義され `applyPlanItems` との近傍配置で依存関係を最小化。`TmCommitResult` も同ファイルに集約済みで一貫性あり。  
**UI:** `TextDocumentContentProvider` パターンの採用は VS Code API の正用法。固定URI + `onDidChange` によるタブ上書き更新はUX上も妥当な設計。  
**Utility:** シングルトンパターンは `Logger` / `StatusManager` の先例に倣っているが、指摘1・2の通りコンストラクタと disposal だけ規約から外れている。  
**テスト:** `generateContent` の 5 ケース（混在・0件・非対称・特殊文字・タイムスタンプフォーマット）は設計仕様の重要パスを網羅しており充足。省略した `setContent`/`provideTextDocumentContent` は自明な薄いラッパーであり許容範囲。  
**設計書:** `docs/design/command_tm.md` に「完了後プレビュー」セクション・コードマップの `tm-result-provider.ts` 行・`command-commit.ts` の `エントリーポイント...プレビュー呼び出し` 記述が追加済みで同期されている。

### 後方互換性

`TmCommitUnitResult` への `newItems`/`updatedItems` 必須フィールド追加により、`commit-processor.ts` 内のスキップ早期返却 3 箇所すべてに `newItems: [], updatedItems: []` が追加されており後方互換の破壊なし。`TmCommitResult` も既存テスト（`commit-processor.test.ts`）に影響なし（戻り値の新フィールドはテスト側で無視される）。

### セキュリティ

仮想ドキュメントはユーザーの手元でのみ表示され、ファイルシステムに書き出されない。`generateContent` はプレーンテキスト出力のみでHTMLを生成しないため、XSSリスクは皆無。問題なし。

---

## 総評

設計チケットの意図が実装に正確に反映されており、品質は全体的に高い。特に `generateContent` が純粋関数として独立しテストしやすい構造になっている点、`showTmCommitPreview` のゼロ件ガードが明確な点は良い設計判断。

推奨修正（`private constructor` + `dispose()`）は2行程度の小変更であり、プロジェクトの規約統一の観点から対応を推奨する。
