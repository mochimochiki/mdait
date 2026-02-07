# チケット: designをdocsに一本化

## 1. 概要と方針

`design/`フォルダを`docs/`フォルダに統合し、user-guideはdocsのサブフォルダのまま維持する。全設計書を設計者にとって真に有用な形に編集し、新たにdocs/architecture.mdとして設計哲学をまとめる。

## 2. 仕様

- `design/`配下の全ファイルを`docs/`直下に移動
- `docs/user-guide/`は現状維持
- 全設計書の内容を深くレビューし、設計段階で役立つドキュメントに編集
- `docs/architecture.md`を新設（設計哲学ドキュメント）
- コードベース内の`design/`への参照を`docs/`に更新

## 3. シーケンス図

N/A（ドキュメント構造変更のため）

## 4. 設計

### フォルダ構造（変更後）
```
docs/
  architecture.md       # NEW: 設計哲学
  _index.md            # 設計ドキュメントインデックス
  design.md            # 全体設計書
  core.md              # コア機能層設計
  api.md               # API層設計
  prompt.md            # プロンプト設計
  config.md            # 設定管理層設計
  ui.md                # UI層設計
  commands.md          # コマンド層設計
  command_setup.md     # setupコマンド設計
  command_sync.md      # syncコマンド設計
  command_trans.md     # transコマンド設計
  command_term.md      # termコマンド設計
  command_trans-selection.md  # オンデマンド翻訳設計
  utils.md             # ユーティリティ層設計
  test.md              # テスト層設計
  user-guide/          # ユーザーガイド（現状維持）
    ja/
```

## 5. 考慮事項

- README.md / README.ja.mdの`design/prompt.md`参照を更新
- .github/agents/配下のagentファイルの参照更新（変更不可のため注意）
- tasks/done/内の過去チケットは歴史的記録のため更新不要
- design.md内のリポジトリ構成説明を更新

## 6. 実装・テスト計画と進捗

- [ ] design/配下の全ファイルをdocs/に移動
- [ ] design/フォルダを削除
- [ ] docs/architecture.md を新設
- [ ] 全設計書の内容を編集・改善
- [ ] コードベース内の参照を更新（README等）
- [ ] _index.md のリンクパスを更新

## 7. 品質要件チェック

- [ ] 全設計書がdocs/に移動済み
- [ ] user-guideが維持されている
- [ ] 参照リンクが正しい
- [ ] architecture.mdの品質確認

## 8. まとめと改善提案

（作業完了後に記載）
