# コードベース構造

## ディレクトリ構成
```
mdait/
├── src/
│   ├── extension.ts                # エントリーポイント
│   ├── api/                        # API層: AIプロバイダー連携
│   │   ├── ai-service-builder.ts
│   │   ├── ai-service.ts
│   │   ├── ai-stats-logger.ts
│   │   └── providers/              # AIプロバイダー実装
│   │       ├── default-ai-provider.ts
│   │       ├── ollama-provider.ts
│   │       └── vscode-lm-provider.ts
│   ├── commands/                   # Commands層: コマンド実装
│   │   ├── setup/
│   │   ├── sync/
│   │   ├── term/
│   │   └── trans/
│   ├── config/                     # Config層: 設定管理
│   │   └── configuration.ts
│   ├── core/                       # Core層: コア機能
│   │   ├── cancellation/           # キャンセル処理
│   │   ├── diff/                   # 差分管理
│   │   ├── hash/                   # ハッシュ計算
│   │   ├── markdown/               # Markdown構造解析・ユニット分割
│   │   ├── snapshot/               # スナップショット管理
│   │   └── status/                 # ステータス情報管理
│   ├── extension/                  # 拡張機能連携
│   │   └── status-save-sync.ts
│   ├── prompts/                    # プロンプト管理
│   │   ├── defaults.ts
│   │   ├── index.ts
│   │   └── prompt-provider.ts
│   ├── test/                       # 単体テスト
│   │   ├── commands/
│   │   ├── core/
│   │   ├── prompts/
│   │   ├── sample-content/         # テスト用サンプルコンテンツ
│   │   ├── utils/
│   │   └── workspace/              # テスト作業ディレクトリ
│   ├── test-gui/                   # GUI/統合テスト
│   │   ├── commands/
│   │   ├── config/
│   │   ├── core/
│   │   ├── extension/
│   │   └── ui/
│   ├── ui/                         # UI層: VS Code UI統合
│   │   ├── codelens/
│   │   ├── hover/
│   │   └── status/
│   └── utils/                      # Utils層: 汎用機能
│       ├── ai-onboarding.ts
│       └── file-explorer.ts
├── design/                         # 設計ドキュメント
│   ├── _index.md
│   ├── design.md
│   ├── api.md
│   ├── commands.md
│   ├── config.md
│   ├── core.md
│   ├── prompt.md
│   ├── test.md
│   ├── ui.md
│   └── utils.md
├── tasks/                          # 作業チケット管理
│   ├── do/                         # 未完了タスク
│   └── done/                       # 完了タスク
├── l10n/                           # 国際化リソース
├── schemas/                        # JSONスキーマ定義
│   └── mdait-config.schema.json
├── package.json                    # プロジェクト定義
├── tsconfig.json                   # TypeScript設定
└── biome.json                      # Biome設定
```

## 層間の依存関係
- **Config層** → 各層への設定提供
- **Core層** → Commands層への基盤機能提供
- **Commands層** → UI層への処理結果通知
- **API層** → Commands層への外部サービス連携
- **Utils層** → 全層への汎用機能提供
