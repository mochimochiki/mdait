## サマリ

**全体評価:** ⭐⭐⭐⭐ (4/5)
**結論:** ⚠️条件付き承認
**指摘件数:** 🔴[重大: 0](#重大) 🟠[優先: 1件](#優先) 🟡[推奨: 1件](#推奨) 🟢[任意: 0件](#任意)
**最重要論点:**
`setup-command.ts` がディレクトリ作成に `ensureMdaitDir()` を使わず直接 `mkdirSync` を呼んでいる。この設計では setup コマンド実行時に `.gitignore` が生成されず、DRY原則にも違反する。パス変更そのものは正確で全体設計と整合。

**変更:**
- [src/config/configuration.ts](../../src/config/configuration.ts#L246): `getConfigFilePath` 戻り値を `.mdait/mdait.json` に変更
- [src/commands/setup/setup-command.ts](../../src/commands/setup/setup-command.ts#L19): 生成先パスを `.mdait/mdait.json` に変更、`mkdirSync` を追加
- [src/extension.ts](../../src/extension.ts#L384): `endsWith` の判定文字列を `path.join(".mdait","mdait.json")` に変更
- [package.json](../../package.json#L333): `fileMatch` を `**/.mdait/mdait.json` に変更
- [src/test/config/configuration.test.ts](../../src/test/config/configuration.test.ts#L9): テスト用プファイル作成パスを `.mdait/mdait.json` に更新
- [src/test/workspace/.mdait/mdait.json](../../src/test/workspace/.mdait/mdait.json): ファイルをルートから `.mdait/` 配下に移動

---
## 🟠優先 (1件)

### `setup-command.ts` が `ensureMdaitDir()` を使わず直接 `mkdirSync` を呼んでいる

**場所:**
- [ ] [setup-command.ts L50](../../src/commands/setup/setup-command.ts#L50)
- [ ] [src/utils/mdait-dir.ts L13](../../src/utils/mdait-dir.ts#L13)

**問題:**
`setup-command.ts` は `.mdait` ディレクトリを作成するのに `fs.mkdirSync(path.join(workspaceFolder, ".mdait"), { recursive: true })` と直接呼んでいる。
しかし `ensureMdaitDir()` はすでに「`.mdait` 作成 ＋ `.gitignore` 自動生成」をワンセットで提供しており、
`ai-stats-logger.ts`・`unit-registry-manager.ts`・`command-commit.ts` など他の全コンポーネントはこのユーティリティを経由している。

結果として setup コマンド実行直後は `.gitignore` が存在せず、ユーザーが最初に他の操作（tmコミット等）を実行するまで `.mdait` が gitignore されない。
**新規セットアップ時に最も確実に `.gitignore` を生成すべきタイミング**で素通りしてしまっている。

**提案:**
```typescript
// 変更前
fs.mkdirSync(path.join(workspaceFolder, ".mdait"), { recursive: true });

// 変更後
await ensureMdaitDir();
```

`ensureMdaitDir()` は vscode API 経由でワークスペースルートを取得するため引数不要。
呼び出し元はすでに `workspaceFolder` を確認済みなので、`null` チェックは不要（失敗時は `ensureMdaitDir` 内で黙認）。
なお `import { ensureMdaitDir } from "../../utils/mdait-dir"` の追加も必要。

---
## 🟡推奨 (1件)

### `configuration.test.ts` の `mkdirSync` に `{ recursive: true }` がない

**場所:**
- [ ] [src/test/config/configuration.test.ts L10](../../src/test/config/configuration.test.ts#L10)

**問題:**
```typescript
fs.mkdirSync(mdaitDir);  // ← { recursive: true } なし
```
`tempDir` 自体は `mkdtempSync` で作成済みなので実際に失敗する可能性はないが、
同プロジェクト内の他のすべての `mkdirSync` 呼び出し（`prompt-provider-instruction.test.ts` L25 等）は `{ recursive: true }` を付けており、一貫性がない。

**提案:**
```typescript
fs.mkdirSync(mdaitDir, { recursive: true });
```

---
## 📊 全体整合性

### ワークスペース全体の整合性

**Core:** 変更なし。Configuration クラスのパス返却ロジックは単純な定数変更で問題なし。
**UI:** `extension.ts` の `path.join(".mdait", "mdait.json")` は Windows（バックスラッシュ）・Linux（スラッシュ）の両方に対して `fsPath` と一致するため正しく機能する。
**Utility:** `ensureMdaitDir()` が `.mdait` ディレクトリの正式な初期化ユーティリティとして機能しているが、setup コマンドで未使用（🟠優先参照）。
**テスト:** テストファイルのパス更新は正確。GUI テストの配置修正（vscode依存テストを `test-gui/` へ移動）もあわせて実施されており品質向上。
**設計書:** `docs/design/config.md`・`docs/design/command_setup.md` が旧パス記述のままだったため、本レビュー時に更新済み。

### 後方互換性

チケット仕様どおり互換性維持なし。旧パス `mdait.json` からの自動マイグレーションは意図的に実装していない。

### セキュリティ

問題なし。ファイル操作は既存パターンを踏襲しており、新たなリスクは発生していない。

---
## 総評

パス変更の実装自体はシンプルかつ正確で、チケット仕様との乖離もない。
`extension.ts` の `path.join` によるクロスプラットフォーム対応、`package.json` の glob パターン変更（`**/.mdait/mdait.json`）も仕様を満たしている。

`ensureMdaitDir()` の未使用は「機能的に破綻はしていないが、設計の一貫性を損なう」種類の問題で、setup コマンドがディレクトリ初期化の完全な責務を果たしていない。修正コストは小さいため対応を推奨する。
