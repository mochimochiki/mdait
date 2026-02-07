# mdait 設計ドキュメントインデックス

このディレクトリは mdait の設計情報をまとめたものです。知りたい内容に応じて以下から該当するドキュメントを参照してください。

## まず読むべきドキュメント

**[architecture.md](architecture.md) - 設計哲学**
- **読むべき時**: mdaitとは何か、なぜこの設計なのかを理解したい
- **内容**: 存在理由、設計哲学の核心、中核となる設計原則、アーキテクチャ全体像

**このドキュメントがすべての設計の指針です。新機能設計時、トレードオフ判断時に必ず参照してください。**

---

## 全体像を知りたい

**[design.md](design.md) - 全体設計書**
- **読むべき時**: システムの階層構造と主要モジュール間の関係を俯瞰したい
- **内容**: 層構造、データフロー、リポジトリ構成、主要コマンドの概要

---

## 層別の設計詳細

### コア機能層
**[core.md](core.md) - コア機能層設計**
- **読むべき時**: mdaitUnitの構造、ハッシュベースの差分検出、ステータス管理の実装を知りたい
- **内容**: mdaitUnit概念、Hash & Normalizer、Status管理、UnitRegistry、Diff生成、FrontMatter翻訳

### コマンド層
**[commands.md](commands.md) - コマンド層概要**
- **読むべき時**: 各コマンドの全体像と共通設計方針を把握したい
- **内容**: sync/trans/term/setupの概要、並列実行制御、キャンセル管理の共通仕様

各コマンドの詳細設計：
- **[command_setup.md](command_setup.md)** - 初期設定フロー
- **[command_sync.md](command_sync.md)** - 差分検出とユニット対応付けのロジック
- **[command_trans.md](command_trans.md)** - 翻訳実行、改訂パッチ、品質チェックの詳細
- **[command_term.md](command_term.md)** - 用語検出・展開の処理フロー
- **[command_trans-selection.md](command_trans-selection.md)** - オンデマンド翻訳（マーカーレス）

### UI層
**[ui.md](ui.md) - UI層設計**
- **読むべき時**: VS Code統合の実装方法を知りたい
- **内容**: StatusTreeProvider、CodeLens、Hover、WelcomeView、自動同期の仕組み

### API層
**[api.md](api.md) - API層設計**
- **読むべき時**: AIプロバイダーの抽象化と実装を理解したい
- **内容**: AIServiceインターフェース、各プロバイダー（OpenAI/Ollama/VSCode LM）の実装詳細

### 設定管理層
**[config.md](config.md) - 設定管理層設計**
- **読むべき時**: mdait.jsonの構造とFrontmatter設定を理解したい
- **内容**: 設定項目一覧、バリデーション、Frontmatterによるドキュメント単位オーバーライド

---

## 横断的関心事

**[prompt.md](prompt.md) - プロンプト設計**
- **読むべき時**: AIプロンプトの内容とカスタマイズ方法を確認したい
- **内容**: 全プロンプトID一覧、変数プレースホルダー、追加指示（Instruction）、入出力形式

**[utils.md](utils.md) - ユーティリティ層設計**
- **読むべき時**: ファイル探索とログ出力の実装を知りたい
- **内容**: FileExplorer、Logger使用方針、構造化ログ規約

**[test.md](test.md) - テスト層設計**
- **読むべき時**: テスト戦略と実行方法を確認したい
- **内容**: テストカテゴリ、サンプルワークスペース、テスト実践のプラクティス
