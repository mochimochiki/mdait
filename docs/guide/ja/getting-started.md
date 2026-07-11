<!-- mdait 8bb3014a -->
# mdait クイックスタート

mdait を5分でセットアップし、最初の翻訳を完成させるための実践ガイドです。

---

<!-- mdait bdffd2da -->
## 前提条件

- **VS Code** がインストール済みであること
- **GitHub Copilot** サブスクリプションが有効であること（AI翻訳に必要）

---

<!-- mdait 440bed45 -->
## インストール

1. [GitHub リリースページ](https://github.com/mochimochiki/mdait/releases) を開く
2. 最新リリースの **Assets** から `mdait-<version>.vsix` をダウンロード
3. VS Code で `Ctrl+Shift+P` → **「Extensions: Install from VSIX...」** を実行
4. ダウンロードした `.vsix` ファイルを選択
5. インストール後、アクティビティバーに 🌐 アイコンが現れる

---

<!-- mdait 198a7749 -->
## mdait.json を作成する

1. アクティビティバーの **🌐 アイコン** をクリックして mdait ビューを開く
2. **「Create mdait.json」** ボタンをクリック
3. ワークスペースルートに `.mdait/mdait.json` が生成される

---

<!-- mdait 26258fb9 -->
## transPairs を設定する

生成された `.mdait/mdait.json` を開き、`transPairs` を自分のプロジェクトに合わせて編集します。

```json
{
  "transPairs": [
    {
      "sourceLang": "ja",
      "sourceDir": "docs/ja",
      "targetLang": "en",
      "targetDir": "docs/en"
    }
  ],
  "primaryLang": "ja",
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  },
  "sync": {
    "level": 3,
    "autoSyncOnSave": true
  }
}
```

| キー | 説明 |
|---|---|
| `sourceLang` | 原文の言語コード（例: `ja`） |
| `sourceDir` | 原文ディレクトリ（ワークスペースルートからの相対パス） |
| `targetLang` | 訳文の言語コード（例: `en`） |
| `targetDir` | 訳文ディレクトリ（ワークスペースルートからの相対パス） |
| `primaryLang` | 用語集・翻訳メモリの基準言語（**必須**。通常は原文の言語）|

> `primaryLang` は省略できません。指定しないと Sync 時に「Primary language (primaryLang) is not configured.」エラーになります。「Create mdait.json」ボタンで生成したテンプレートには既定値が入っています。

> `sourceDir` / `targetDir` は `.mdait/mdait.json` と同じワークスペースルートからの相対パスです。

---

## すでに翻訳済みの文書がある場合

原文・訳文の両方がすでに存在するサイト（手翻訳や別ツールで作った対訳）を移行する場合は、次の「最初の同期」の代わりに **✨既存翻訳の取り込み** を使ってください。既訳を上書きせずに管理下へ取り込み、用語集・翻訳メモリも同時に構築できます。詳細は [adopt.md](adopt.md) を参照してください。

---

<!-- mdait f92cd855 -->
## 最初の同期（Sync）

Sync は原文 Markdown を走査し、翻訳管理用の **マーカー** を挿入します。

1. mdait ビューのサイドバーで **🔄 Sync** ボタンをクリック
2. `sourceDir` 以下のすべての `.md` ファイルにマーカーが挿入される
3. `targetDir` に同じ構造の空ファイルが生成される

マーカーの例：

```markdown

<!-- mdait a1b2c3d4 need:translate -->
# はじめに
これはサンプルドキュメントです。
```

マーカーは原文の変更を追跡します。ハッシュが変わると `need:revise` ステータスになり、再翻訳が必要なことが分かります。

---

<!-- mdait 99dda58b -->
## 最初の翻訳

<!-- mdait 1cefad09 -->
### 方法 A — 1ユニットだけ翻訳（CodeLens）

1. 原文ファイルをエディタで開く
2. マーカー行の直上に表示される **「Translate Unit」** CodeLens をクリック
3. 訳文が `targetDir` の対応ファイルに書き込まれる

<!-- mdait f1b2302d -->
### 方法 B — ファイル単位で翻訳（サイドバー）

1. mdait ビューのサイドバーでファイルの ▶ ボタンをクリック
2. ファイル内のすべての未翻訳ユニットが順に翻訳される

---

<!-- mdait 14c30abf -->
## 結果を確認する

<!-- mdait ec3c4447 -->
### Hover で訳文を確認

原文のマーカー上にカーソルを乗せると、現在の訳文とステータスがポップアップ表示されます。

<!-- mdait a5654c59 -->
### Source で並列表示

1. サイドバーまたは訳文ファイルで **「Source」** をクリック
2. 原文と訳文が左右に並んで表示され、品質確認が容易になる。原文側のスクロールに合わせて訳文も自動でスクロールされる

---

<!-- mdait dfd3cda6 -->
## 次のステップ

- [concepts.md](concepts.md) — マーカー・ユニット・Sync の仕組みを理解する
- [sync.md](sync.md) — Sync の詳細設定とオプション
- [translate.md](translate.md) — 翻訳オプション・用語集・翻訳メモリの活用
- [troubleshooting.md](troubleshooting.md) — よくある落とし穴と対処（うまく動かないとき）
