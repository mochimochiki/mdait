# チケット: tm-commit need:review除外

## 1. 概要と方針

tm-commitコマンドの処理対象判定において、`from属性あり + need:review`の場合をスキップ対象に変更する。現在は処理対象となっているが、レビュー待ちの訳文はTMに登録すべきでないという仕様変更。

## 2. 仕様

### 変更前
| 条件 | 判定 | 理由 |
|---|---|---|
| `from`属性あり + `need:review` | 処理対象 | 翻訳済み（レビュー待ち） |

### 変更後
| 条件 | 判定 | 理由 |
|---|---|---|
| `from`属性あり + `need:review` | スキップ | レビュー待ち（未承認） |

## 3. シーケンス図

```mermaid
sequenceDiagram
    participant User
    participant Cmd as TmCommitCommand
    participant Proc as TmCommitProcessor
    
    User->>Cmd: mdait.tm-commit.file
    
    rect rgb(230, 240, 255)
        Note over Cmd: 対象ユニット選定
        loop 各ユニット
            Cmd->>Cmd: isTmCommitTarget(unit)
            alt from属性なし
                Note over Cmd: スキップ（ソース）
            else need:translate
                Note over Cmd: スキップ（未翻訳）
            else need:revise@*
                Note over Cmd: スキップ（旧版）
            else need:review ← NEW
                Note over Cmd: スキップ（レビュー待ち）
            else その他（needなし等）
                Note over Cmd: 処理対象
                Cmd->>Proc: processUnit()
            end
        end
    end
```

## 4. 設計

### 変更対象
- **ファイル**: `src/commands/tm-commit/tm-commit-command.ts`
- **関数**: `isTmCommitTarget(unit: MdaitUnit): boolean` (51-62行目)
- **ドキュメント**: `docs/command_tm-commit.md` (30行目の表)

### 実装詳細
`isTmCommitTarget`関数に以下のチェックを追加:
```typescript
if (unit.marker.need === "review") {
    return false;
}
```

## 5. 考慮事項

- **既存テストへの影響**: `src/test/commands/tm-commit/`配下のテストがあればチェックが必要
- **ドキュメント整合性**: `docs/command_tm-commit.md`の仕様表を必ず更新
- **後方互換性**: 既存のTMファイルには影響なし（判定ロジックのみ変更）
- **UI表示**: StatusTreeでの表示は変更不要（tm-commit対象判定のみの変更）

## 6. 実装・テスト計画と進捗

- [ ] explorerエージェントで影響範囲の確認
- [ ] coderエージェントで実装
  - [ ] `isTmCommitTarget`関数の修正
  - [ ] `docs/command_tm-commit.md`の仕様表の更新
  - [ ] 既存テストの実行と必要に応じた修正
- [ ] reviewerエージェントでコードレビュー
- [ ] 修正が必要な場合の対応

## 7. 品質要件チェック

- [ ] 仕様変更が正しく実装されている
- [ ] ドキュメントが更新されている
- [ ] 既存テストが通過する
- [ ] 変更が最小限である

## 8. まとめと改善提案

（作業完了後に記載）

## 9. 参考

- 関連ドキュメント: `docs/command_tm-commit.md`
- 関連実装: `src/commands/tm-commit/tm-commit-command.ts`
