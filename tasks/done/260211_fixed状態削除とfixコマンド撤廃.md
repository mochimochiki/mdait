# チケット: fixed状態削除とfixコマンド撤廃

## 1. 概要と方針

`fixed`状態はリリース前に不要と判断された。`fixed`に関連するすべてのコード（マーカー定義、fixコマンド群、CodeLens、メニュー、テスト、l10n）を完全に削除する。TM登録フィルターの`isFixed()`チェックも削除し、後続チケットでのTM登録リデザインに備える。

## 2. 仕様
- `<!-- mdait ... fixed -->` マーカーの `fixed` キーワードを廃止
- `mdait.fix.*` コマンド群（6コマンド）を全廃
- CodeLensの「確定」「確定(+TM)」ボタンを削除
- ステータスツリーのfixed関連表示を削除
- TM登録フィルターから`isFixed()`条件を削除

## 3. シーケンス図
N/A（削除作業のため）

## 4. 設計

### 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/core/markdown/mdait-marker.ts` | `fixed`プロパティ、`isFixed()`、`setFixed()`、正規表現から削除 |
| `src/commands/fix/fix-command.ts` | ファイル全体を削除 |
| `src/extension.ts` | fix系コマンド6件の登録を削除 |
| `src/ui/codelens/codelens-provider.ts` | fix系CodeLens生成ロジック削除 |
| `src/ui/status/status-tree-provider.ts` | fixed関連の表示ロジック削除（あれば） |
| `src/commands/tm-commit/tm-commit-filter.ts` | `isFixed()`チェック削除 |
| `package.json` | fix系コマンド定義・メニュー項目削除 |
| `package.nls.json` / `package.nls.ja.json` | fix関連の翻訳キー削除 |
| `l10n/bundle.l10n.json` / `l10n/bundle.l10n.ja.json` | fix関連文字列削除 |
| テストファイル | fixed関連テスト削除・更新 |

## 5. 考慮事項
- 既存のMarkdownファイルに `fixed` マーカーが残っている可能性があるが、リリース前のため無視可能
- `MdaitMarker.parse()` は後方互換性のため `fixed` キーワードを無視するよう実装してもよいが、リリース前なのでそのまま削除で問題ない

## 6. 実装・テスト計画と進捗
- [x] `MdaitMarker` からfixed関連コード削除
- [x] `fix-command.ts` 削除
- [x] `extension.ts` からfix系コマンド登録削除
- [x] `codelens-provider.ts` からfix系CodeLens削除
- [x] `tm-commit-filter.ts`の`isFixed()`チェック削除
- [x] `package.json`からfix系定義削除
- [x] `l10n`ファイル更新
- [x] テストファイル更新
- [x] ユーザーガイド・ドキュメント更新
- [x] テストワークスペースのmdait.json修正
- [x] ビルド確認
- [x] テスト確認

## 7. 品質要件チェック
- [x] ビルドエラーなし
- [x] 既存テストがパスする（289 passing）
- [x] fixedへの参照が残っていない

## 8. まとめと改善提案
（作業完了後に記載）

## 9. 参考
N/A
