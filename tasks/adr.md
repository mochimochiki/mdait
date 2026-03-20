# ADR

## 2026-03-15 TMコミット応答分離は anchor-aware 契約の後段解釈として扱う

- 状態: 承認
- 関連チケット: [tasks/done/260315_TMコミットLLM応答分離設計更新.md](done/260315_TMコミットLLM応答分離設計更新.md)

### 文脈

TMコミットの概念整理として、既存TUへのローカライズ展開と新規TM追加を `localizedMappings` / `additions` に分離したい要望が出た。しかし保存側の正式契約はすでに `tm.alignWithPrimaryAnchors` で承認済みであり、新しい PromptId や別識別子を導入すると同じ責務の契約が二重化する恐れがあった。

### 決定

- authoritative な保存側契約は `tm.alignWithPrimaryAnchors` を維持する
- `localizedMappings` / `additions` は `anchorAction = reuse/create` の後段分類として扱う
- 識別子は `tuid` に統一し、`primaryHash` のような別名は正式契約に持ち込まない
- Prompt の正式入力は `primaryLangUnit` / `counterpartUnit` / `existing TM set` とする
- `existing TM set` の `tuid / primarySentence / localSentence` と omission / `needUpdate=true` の規則を processor で固定する

### 影響

- 設計書は新契約追加ではなく、承認済み契約の補強として読めるようになる
- 実装者が PromptId を二重実装したり、保存キーを別名で分岐させるリスクを減らせる
- 既存 local sentence の保持、無効更新、未解決 no-op の扱いをコードへ落とし込みやすくなる

## 2026-03-15 TM正本管理と参照方式の分離

- 状態: 承認
- 関連チケット: [tasks/done/260315_TM正本管理と参照方式再設計.md](done/260315_TM正本管理と参照方式再設計.md)

### 文脈

既存 TM は source sentence hash ベースの exact lookup 中心設計で、多段翻訳や改訂時に TU が分裂しやすく、obsolete 文の除去と翻訳前参照の責務も混線していた。

### 決定

- `primaryLang` を mdait 全体の top-level 基盤設定にする
- TM の正本は `primaryLang` の sentence とし、`tuid = hash(norm(primary_sentence))` を唯一の保存キーにする
- `sync` は unit レベル差分と current primary units 準備のみを担当する
- cleanup は `x-unit-hash` 候補抽出と primary `seg` 実文照合の二段階で obsolete TU を削除する
- `tm-commit` は sentence segmentation / alignment / primary sentence 決定 / TU upsert のみを担当する
- trans 側の TM 参照は exact lookup ではなく translation example retrieval とし、candidate generation と ranking を分離する

### 影響

- 設定 schema と runtime から `terms.primaryLang` を除去する
- TMX 保存モデルは primary `tuv` 必須の TU 正本管理へ変わる
- cleanup と retrieval は保存側 repository と分離したサービスとして実装する
- 初期段階での `tm-commit` 正式対応は `primaryLang` を含む pair に限定する

## 2026-03-15 TM多言語マージの anchor-aware commit 化

- 状態: 承認
- 関連チケット: [tasks/done/260315_TM多言語マージ再設計修正.md](done/260315_TM多言語マージ再設計修正.md)

### 文脈

`primaryLang` を正本に据えた後も、tm-commit が pair 相対の source/target 対称契約を残していたため、multi-hop commit で既存 primary sentence を再利用できず、同一概念が別 TU に分裂していた。さらに variant metadata の更新主体が曖昧で、`x-unit-path` が commit 文脈依存で誤る余地があった。

### 決定

- tm-commit の保存側入力は `primaryLangUnit` と `counterpartUnit` を正準とする
- repository から `currentPrimaryAnchors` を取得し、LLM には `tm.alignWithPrimaryAnchors` で既存 primary sentence の再利用を要求する
- TU 一意性は引き続き `tuid = hash(norm(primary_sentence))` とし、`reuse` 行は既存 TU へ、`create` 行のみ新規 TU 候補とする
- `x-unit-path` / `x-unit-hash` は各 `tuv` の metadata とし、primary variant は `primaryLangUnit`、non-primary variant はその `counterpartUnit` だけが更新する
- `primaryLang` 必須化は schema だけでなく runtime の configured state と tm-commit 入口 validation に反映する

### 影響

- multi-hop `ja -> en -> zh-hans` commit で同一 primary sentence が 1 TU に集約される
- changed-unit 初回再commitでも、同一 `unitPath` 上に残る primary sentence を anchor fallback として再利用できる
- `tm.splitSentences` と commit 用 prompt の責務が分離され、カスタム prompt でも merge 契約を明示しやすくなる