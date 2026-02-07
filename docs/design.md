# 全体設計書

> **設計哲学**: このドキュメントを読む前に [architecture.md](architecture.md) を参照してください。  
> mdaitの存在理由、設計哲学、中核となる原則が記載されています。

## システム概要

mdaitは、Markdownの構造を活かした**継続的な多言語文書管理**を実現するVS Code拡張機能です。文書を「ユニット」に分割し、ハッシュベースの差分検出により、原文の変更箇所のみを再翻訳します。

### 解決する課題

- 原文変更時、どこを再翻訳すべきか人間の目視に依存している
- 翻訳後の手修正が原文変更で消えてしまう
- 用語集があっても実際の翻訳で反映される保証がない

### mdaitのアプローチ

- **ユニット単位の管理**: Markdown文書内にHTMLコメントマーカーを埋め込み、ユニットごとに状態管理
- **ハッシュによる追跡**: CRC32で内容変更を検出し、変更箇所のみに`need:translate`を付与
- **diff-aware revise**: 原文変更時、LLMに差分を提示して訳文へのパッチのみを生成

---

## 階層構造

mdaitは責務分離を徹底した層構造を持ちます：

```
UI層 (ui.md)        VS Code統合、ユーザーインタラクション
   ↓
Commands層 (commands.md)   ビジネスロジック、ワークフロー制御
   ↓                       ↓
Core層 (core.md)    API層 (api.md)
純粋な翻訳ロジック     外部AI通信
   ↓                       ↓
Config層 (config.md) / Utils層 (utils.md)
設定管理 / 汎用機能
```

**設計意図**: Core層をVS Code APIから独立させることで、ロジックの単体テストが容易になり、将来的な他環境への移植可能性も担保されます（[architecture.md](architecture.md) P5参照）。
---

## リポジトリ構成

```
src/
  extension.ts           # VS Code拡張機能のエントリーポイント
  commands/              # ワークフロー制御とビジネスロジック
    ├── sync/            # ユニット同期・差分検出
    ├── trans/           # 翻訳実行・品質チェック
    ├── term/            # 用語検出・展開
    ├── setup/           # 初期設定
    └── trans-selection/ # オンデマンド翻訳
  core/                  # 純粋な翻訳ドメインロジック
    ├── markdown/        # 構造解析、ユニット分割、marker処理
    ├── hash/            # 正規化とハッシュ計算
    ├── status/          # ステータス情報管理
    ├── unit-registry/   # ユニット内容のスナップショット管理
    └── diff/            # unified diff生成
  api/                   # 外部AIサービス通信
  ui/                    # VS Code UI統合
  config/                # 設定ロード・バリデーション
  utils/                 # ファイル探索、ログ出力
  prompts/               # AIプロンプト定義
  test/                  # テスト
docs/                    # 設計ドキュメント（このディレクトリ）
schemas/                 # JSON Schema定義
l10n/                    # 国際化リソース
```

---

## mdaitUnitの構造

mdaitの管理単位である**mdaitUnit**は、Markdown本文とHTMLコメントマーカーのペアで構成されます。

### マーカー形式

```markdown
<!-- mdait {hash} [from:{hash}] [need:{flag}] -->
```

- **hash**: ユニット内容の正規化後CRC32（8文字）
- **from**: 翻訳元ユニットのハッシュ（オプショナル）
- **need**: 必要なアクション（オプショナル）
  - `translate` - 新規翻訳が必要
  - `revise@{oldhash}` - 原文変更により改訂が必要（oldhashは旧原文のハッシュ）
  - `review` - 人手確認が推奨される
  - `verify-deletion` - 削除確認が必要

### マーカー配置のルール

- マーカーの直後（空行なし）に見出しがある場合、その見出しがユニットのタイトル
- ユニット境界は「指定レベル以下の見出し」または「mdaitマーカー」で決定
- ハッシュ省略マーカー `<!-- mdait -->` もsync時に自動計算される

**設計意図**: マーカーをHTMLコメントとして埋め込むことで、外部データベース不要で文書と管理情報を一体管理します（[architecture.md](architecture.md) 哲学1参照）。Markdownの純粋性は多少損なわれますが、レンダリング時には不可視であり、この小さな代償で長期運用の安定性を得ています。

---

## 主要コマンド

### sync - ユニット同期

ソースとターゲットのMarkdownファイル間でユニット対応を確立し、差分を検出します。

**主な処理**:
1. ソース・ターゲットのユニットをパース
2. `SectionMatcher`でユニット対応を確立
3. ハッシュ比較で変更を検出
4. 変更箇所に`need:translate`または`need:revise@{oldhash}`を付与
5. `.mdait/unit-registry`にユニット内容を保存（diff生成用）

**詳細**: [command_sync.md](command_sync.md)

### trans - 翻訳実行

`need:translate`が付与されたユニットをAI翻訳します。

**主な処理**:
1. 翻訳対象ユニットを収集
2. 用語集から関連用語を抽出
3. **改訂時は差分パッチ翻訳**: 旧コンテンツとの差分（unified diff）をLLMに提示し、前回訳文へのパッチのみを返させる
4. 翻訳品質チェック（構造比較）
5. ハッシュ更新、needフラグ除去

**設計意図**: diff-aware reviseにより、変更箇所以外は既存訳文を維持します。これは「原文と訳文の両方が変更される」ことを通常のワークフローとして扱う設計です（[architecture.md](architecture.md) 哲学3参照）。

**詳細**: [command_trans.md](command_trans.md)

### term - 用語管理

原文から重要用語を検出し（`term.detect`）、既訳から訳語を抽出します（`term.expand`）。

**詳細**: [command_term.md](command_term.md)

### setup - 初期設定

`mdait.template.json`をワークスペースにコピーし、初期設定を支援します。

**詳細**: [command_setup.md](command_setup.md)

---

## データフローの全体像

```mermaid
graph LR
    A[原文変更] --> B[sync検出]
    B --> C[need:revise付与]
    C --> D[trans実行]
    D --> E[diff-aware revise]
    E --> F[訳文更新]
    F --> G[sync再実行]
    G --> H[needクリア]
```

1. 原文が変更される
2. `sync`がハッシュ変更を検出し、`need:revise@{oldhash}`を付与
3. `trans`が実行され、旧コンテンツとの差分を取得
4. LLMに差分と前回訳文を提示し、訳文へのパッチを生成
5. パッチを適用して訳文を更新
6. `sync`を再実行してハッシュを更新、needをクリア

**設計意図**: すべてのコマンドは冪等です。何度実行しても結果は一貫します（[architecture.md](architecture.md) 哲学4参照）。

---

## 国際化（l10n）

VS Code標準l10nシステムにより、日本語・英語をサポート。

- `/l10n/bundle.l10n.json` - 英語リソース
- `/l10n/bundle.l10n.ja.json` - 日本語リソース
- `package.nls.json` / `package.nls.ja.json` - package.jsonの多言語化

---

## 開発・デバッグ

### ビルド・実行
```bash
npm run compile  # TypeScriptコンパイル
npm run lint     # コード品質チェック  
npm run test     # 単体テスト実行
npm run test:vscode  # VS Code統合テスト
npm run watch    # 開発時の自動ビルド
```

### テスト環境
- `src/test/sample-content/` - テスト用原稿
- `src/test/workspace/` - テスト作業ディレクトリ
- **詳細**: [test.md](test.md)
