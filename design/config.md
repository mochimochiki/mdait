# 設定管理層設計

## Configurationクラスの骨子

- シングルトンとして`initialize()`でロード、`getInstance()`で提供。
- ワークスペースルートの`mdait.json`ファイルから設定を読み込む。
- JSON Schema (`schemas/mdait-config.schema.json`) による補完と検証をサポート。
- 実装: [src/config/configuration.ts](../src/config/configuration.ts)

## オンボーディングサポート

- `isConfigured()`メソッドで`mdait.json`の存在と妥当性をチェック
- 初期セットアップ時は`mdait.setup.createConfig`コマンドで`mdait.template.json`から設定ファイルを生成
- `mdaitConfigured`コンテキスト変数でUI表示を制御し、未設定時はWelcome Viewを表示
- `package.json`の`jsonValidation`でJSON Schemaを関連付け、IDE上でIntelliSenseと検証が機能

## ロードシーケンス

```mermaid
sequenceDiagram
		participant VS as VS Code
		participant Cfg as Configuration
		participant FS as File System
		participant Caller as Commands/Core/API

		VS->>Cfg: initialize(context)
		Cfg->>FS: mdait.jsonの読み込み
		FS-->>Cfg: JSON内容
		Cfg->>Cfg: パース+型チェック
		Cfg->>FS: ファイル変更監視の開始
		Caller->>Cfg: getInstance()
		Cfg-->>Caller: 設定スナップショット
		FS->>Cfg: ファイル変更イベント
		Cfg->>Cfg: 値リロード
```

## mdait.jsonフォーマット

```json
{
  "$schema": "./schemas/mdait-config.schema.json",
  "transPairs": [
    {
      "sourceDir": "docs/ja",
      "targetDir": "docs/en",
      "sourceLang": "ja",
      "targetLang": "en"
    }
  ],
  "ignoredPatterns": ["**/node_modules/**"],
  "sync": {
    "autoMarkerLevel": ,
    "autoDelete": true
  },
  "ai": {
    "provider": "default",
    "model": "gpt-4o",
    "ollama": {
      "endpoint": "http://localhost:11434",
      "model": "llama2"
    },
    "debug": {
      "enableStatsLogging": false,
      "logPromptAndResponse": false
    }
  },
  "trans": {
    "markdown": {
      "skipCodeBlocks": true
    }
  },
  "terms": {
    "filename": "terms.csv",
    "primaryLang": "en"
  }
}
```

`$schema`フィールドによりVS Code上で以下が機能:
- プロパティの補完
- 型の検証
- ホバーヘルプ表示
- フォーマット例の提示

## バリデーション

- `validate()`メソッドは以下をチェック（設定ファイルロード後に使用）:
  - 必須フィールド(`transPairs`)の有無
  - ディレクトリパスの妥当性
- `isConfigured()`メソッドは設定ファイルの存在とtransPairsの有無を簡易チェック
- `isConfigured()`がfalseの場合、`StatusTreeProvider`が空配列を返しリソース消費を抑制
- `mdaitConfigured`コンテキスト変数を更新し、ツールバーボタンとWelcome Viewの表示を切り替え

## 考慮事項

- 設定値は不変オブジェクトとして呼び出し側に渡し、副作用を避ける。
- 単体テストでは`dispose()`でシングルトンを明示的に破棄し、設定の独立性を保つ。
- 非同期設定（プロバイダー資格情報など）が増える場合はPromiseベースのアクセサを追加する余地を残す。
- `mdait.json`が存在しない場合は`isConfigured()`がfalseを返し、オンボーディングフローに誘導する。
- JSON形式により外部依存なし・ネイティブサポートを実現、YAML形式は廃止。

## 関連

- コマンド挙動: [commands.md](commands.md)
- プロバイダー構築: [api.md](api.md)
- テスト設定: [test.md](test.md)