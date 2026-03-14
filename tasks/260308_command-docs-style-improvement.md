# チケット: command_xxxx.md 全ドキュメントスタイル改善

## 1. 概要と方針

`command_sync.md`をスタイルリファレンスとして、他の全`command_xxxx.md`ファイルを同一スタイルへ改善する。
サブエージェントを活用し、調査・執筆・評価・修正ループをm.doc.pmが統括する。

## 2. 対象ファイル

| ファイル | 状態 |
|---|---|
| `docs/command_sync.md` | ✅ リファレンス（完成済み） |
| `docs/command_setup.md` | 要改善 |
| `docs/command_trans.md` | 要改善 |
| `docs/command_trans-selection.md` | 要改善 |
| `docs/command_tm.md` | 要改善 |
| `docs/command_term.md` | 要改善 |

## 3. スタイルリファレンス構造（command_sync.mdより）

```
# <コマンド名>

<一文説明>

> **ワークフロー位置:** ... ナビゲーション

## 機能
### 何をするか（概要）
### before/after（具体例）
### 前提・操作（表）
### 結果（表）
### エラー処理

---

## 設計
### 概要
### 処理フロー（mermaidシーケンス図）
### 設計ノート（箇条書き）
### 主要コンポーネント（表）
```

## 4. 実装・テスト計画と進捗

- [x] フェーズ1: 実装コード調査（search_subagent）
- [x] フェーズ1: 既存ドキュメント調査（m.researcher）
- [x] フェーズ2a: command_setup.md → 既にスタイル適合済み（改善不要）
- [x] フェーズ2b: command_trans.md → 既にスタイル適合済み（改善不要）
- [x] フェーズ2c: command_trans-selection.md 全面改訂（大幅乖離→スタイル適合）
- [x] フェーズ2d: command_tm.md 修正（不正行・破損セクション除去＋mermaid図追加）
- [x] フェーズ2e: command_term.md 修正（重複行・孤立箇条書き除去＋mermaid図追加）
- [x] フェーズ3: 全ファイル品質評価（m.researcher）
- [x] フェーズ4: 修正ループ（command_trans-selection.mdの設計ノート・主要コンポーネント追記）
- [x] フェーズ5: 完了報告

## 5. 考慮事項

- `command_sync.md`のリンク先（`command_setup.md`等）との相互参照を維持する
- 行数制約: 初稿200行以内
- ワークフロー位置ナビゲーションバーの整合性確認
- 各コマンドの実装コードを正確に反映する

## 6. 参考

- リファレンス: `docs/command_sync.md`
- 実装: `src/commands/`以下の各ディレクトリ
