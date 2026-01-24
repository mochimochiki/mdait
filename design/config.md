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

[schemas/mdait-config.schema.json](../schemas/mdait-config.schema.json)で定義された形式に従う。主なフィールドは以下の通り:

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
    "level": ,
    "autoDelete": true,
    "autoSyncOnSave": true
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
    },
    "frontmatter": {
      "keys": ["title", "description"]
    },
    "contextSize": 1
  },
  "terms": {
    "filename": "terms.csv",
    "primaryLang": "en"
  }
}
```

## バリデーション

- `validate()`メソッドは以下をチェック（設定ファイルロード後に使用）:
  - 必須フィールド(`transPairs`)の有無
  - ディレクトリパスの妥当性
- `isConfigured()`メソッドは設定ファイルの存在とtransPairsの有無を簡易チェック
- `isConfigured()`がfalseの場合、`StatusTreeProvider`が空配列を返しリソース消費を抑制
- `mdaitConfigured`コンテキスト変数を更新し、ツールバーボタンとWelcome Viewの表示を切り替え

## Frontmatter

Markdown文書の先頭にあるfrontmatterセクションで、YAML形式でメタデータを記述する。

### mdait名前空間

mdaitの内部設定は`mdait`名前空間の下に階層的に配置する。

```yaml
mdait:
  sync:
    level: 2
  front: abc123de from:def456gh need:translate
```

### mdait.sync.level

**用途**: ユニット境界として検知する見出しレベルの指定
**形式**: ネスト構造で指定
**概要**:
- mdait.json の sync.level 設定をドキュメント単位で上書き
- パース時に[MarkdownItParser](../src/core/markdown/parser.ts)が frontmatter から読み込み、グローバル設定より優先
- 特定ドキュメントのみ異なる粒度でユニット分割したい場合に活用

**例**:
```yaml
mdait:
  sync:
    level: 3
```

### mdait.front

**用途**: Frontmatterの翻訳状態管理（本体の<!-- mdait ... -->マーカーに相当）
**形式**: ネスト構造で`mdait.front`キーに値を指定
**概要**:
- Frontmatter全体のハッシュ値、翻訳元ハッシュ、必要アクションを追跡
- 本体のMarkdown内のmarkerとは異なり、frontmatter独自のメタデータとして使用
- syncコマンド実行時にハッシュが更新され、transコマンドで翻訳対象判定に利用

**例**:
```yaml
mdait:
  front: abc123de from:def456gh need:translate
```
