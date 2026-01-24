# レビュー結果

## 指摘事項

### 1. 重大度: 中
- ファイル: [src/core/status/status-collector.ts](src/core/status/status-collector.ts#L293-L331)
- 問題の説明:
  - frontmatterのみを持つソースファイルで、`Status.Source` にならず `Status.NeedsTranslation` にフォールバックします。
  - `allUnitsSource` 判定が `units.length > 0` に依存するため、ユニットが0件のケースは Source 判定に到達できません。
  - 結果として、ソース側frontmatter-onlyファイルが「翻訳が必要」と誤表示され、UI・進捗カウント・操作導線を誤誘導します。
- 修正方針と提案内容:
  - ユニット0件かつ `frontmatterItem.status === Status.Source` の場合に `Status.Source` を返す分岐を追加。
  - もしくは「Source判定」を `units.length === 0` でも成立するよう条件式を調整。

