# design-keeper

> 設計整合性を維持するための知識集。汎用部分とリポジトリ専用部分に分割済み。
> 最終目的: これを汎用 skill + リポジトリ専用 skill に昇格させる。

---

## Part 1: 汎用レビュー観点（どのプロジェクトでも使える）

### G-1. ファイル探索パターンのハードコードは「拡張忘れ」の温床

```
パターン例: "**/*.md" などをコード内に直書きしている箇所
発生しやすい場所: findFiles, glob, directory walk など
```

**問題**: 新しいファイルタイプへの対応追加後、ファイル探索部分だけが更新されず機能が「あるのに動かない」状態になる。

**対策**: ファイルタイプのリストは設定から取得し、glob 構築を共通ユーティリティに集約する。コードに拡張子リテラルが残っていたら「意図的か？」を確認する。

**今回の実例**: `status-tree-translation-handler.ts` の `translateDirectory` が `"**/*.md"` ハードコードで、`trans.extensions` に `.txt` を追加しても非 MD ファイルを翻訳できなかった。

---

### G-2. Strategyパターン導入後に「適用範囲の境界」が曖昧になる

```
Strategyパターン: FileHandlerFactory → MdFileHandler / PlainFileHandler
```

**問題**: Factory でハンドリングを抽象化しても、Factory 呼び出し「前」（ファイル列挙、フィルタ）の処理が設定ドリブンになっていないと、新しいファイルタイプが Factory まで到達しない。

**確認ポイント**:
- 「ファイルを選ぶ処理」と「ファイルを処理する Strategy」が別レイヤーにあり、前者が設定ドリブンになっているか。
- 新しいファイルタイプを設定に追加したとき、ファイル列挙〜Factory〜処理まで通してテストできるか。

---

### G-3. VS Code `contextValue` の非対称は「設計判断か実装漏れか」が見えにくい

```
例: when: "viewItem == mdaitFileTargetComplete" に mdaitPlainFileTargetComplete がない
```

**問題**: `package.json` の `when` 条件を読んで「なぜ Plain 版がないのか」が判断できない。バグなのか意図的制限なのかを後から追跡しにくい。

**対策**:
- 意図的な非対称には `package.json` 近傍コメントか設計書に理由を記す。
- 新コマンド追加チェックリスト: 「Plain ファイル variant の `when` 対応は必要か？」を確認する。

---

### G-4. 設定フィールドパスの誤記はユーザーに直接影響する

```
例: transPairs[].extensions（誤）vs trans.extensions（正）
```

**問題**: 設計書やドキュメントの「設定フィールド表」に誤記があると、ユーザーが設定ファイルを誤記して動かない。

**対策**: **JSONSchema を正源**とし、設計書はスキーマから生成または参照する。少なくとも「スキーマを正源とする」方針を明示する。

---

### G-5. 「意図的な制限」は必ずコメント・文書に明記する

```
例: command-optimize.ts が非MDファイルを意図的に除外している
例: term/TM 機能が非MDに非対応（ユニット分割なし）
```

**問題**: 未文書の制限は「バグ」に見える。将来の開発者が理由もわからず直そうとする、あるいは制限を前提とした設計を崩す。

**テンプレコメント**:
```typescript
// NOTE: [機能名] は [理由] のため [対象] のみを対象とする。
// [除外対象] への対応は [設計上の理由/将来計画].
```

---

## Part 2: このリポジトリ専用の観点

### R-1. `contextValue` 体系の命名規則

| contextValue | 意味 |
|---|---|
| `mdaitFileSource` | MD ソースファイル（翻訳元） |
| `mdaitFileTarget` | MD 翻訳ファイル（翻訳待ち） |
| `mdaitFileTargetComplete` | MD 翻訳ファイル（翻訳済み） |
| `mdaitPlainFileSource` | 非 MD ソースファイル |
| `mdaitPlainFileTarget` | 非 MD 翻訳ファイル（翻訳待ち） |
| `mdaitPlainFileTargetComplete` | 非 MD 翻訳ファイル（翻訳済み） |
| `mdaitDirectorySource` | ソースディレクトリ |
| `mdaitDirectoryTarget` | 翻訳先ディレクトリ（未完） |
| `mdaitDirectoryTargetComplete` | 翻訳先ディレクトリ（完了） |

**チェックリスト（新コマンド追加時）**:
- [ ] MD ファイル用 `when` 条件で動作を確認した
- [ ] Plain ファイルにも適用すべきか判断した（する場合 `mdaitPlainFile*` を追加）
- [ ] ディレクトリにも適用すべきか判断した

---

### R-2. FileHandler Strategy の適用範囲

```
適用範囲: Factory に渡された時点で「翻訳対象ファイルであること」が保証済み
```

- ファイル列挙（`getSourceFiles`, `findFiles` 等）は **Strategy の外**。ここが設定ドリブンになっていないと非 MD が処理されない。
- Factory は `.md` 以外を受け取ったとき `PlainFileHandler` にフォールバックする（全拡張子対応）。
- ファイル列挙に拡張子リテラルを書いたら「意図的除外か？」を確認すること。

---

### R-3. `trans.extensions` の制約

```
現在: グローバル設定（全 transPair に適用）
設計外: per-pair で異なる拡張子（例: ja→en は .txt のみ、en→zh は .md のみ）
```

この制約は ADR に未記載。将来の per-pair 対応要求があった場合の設計変更コストが大きいため、設計判断として記録しておく。

**制約が許容される理由**:
- 現実的ユースケースでは「同じプロジェクトで拡張子を言語ペアによって変える」需要は極めて少ない。
- per-pair にすると sourceDir が複数ペアで共有されるケースで「どの拡張子を使うか」が不定になる。

---

### R-4. term/TM 機能の非 MD 制限

| 機能 | 非 MD 対応 | 理由 |
|---|:---:|---|
| sync | ✅ | ファイル全体を1ユニットとして扱う |
| trans（翻訳） | ✅ | PlainFileHandler 経由 |
| term.detect | ❌ | ユニット分割・マーカーなし |
| term.expand | ❌ | 同上 |
| tm.commit | ❌ | term 機能に依存 |
| tm.optimize | ❌（意図的） | Sentence Query はユニット単位のため非 MD を含めても無意味 |

将来 term/TM を非 MD に対応させるには `UnitPairCollector` と `status-tree-term-handler.ts` の変更が必要。

---

## Part 3: Skill 化への分割案

```
汎用 skill (どのプロジェクトにも使える)
→ .github/skills/design-integrity-review/
  - G-1〜G-5 をチェックリスト形式に整理
  - VS Code 拡張特有の contextValue 設計パターン

リポジトリ専用 skill (mdait 専用)
→ .github/skills/mdait-design-keeper/
  - R-1〜R-4 の具体的な体系・命名規則
  - FileHandler Strategy の適用範囲定義
  - trans.extensions の制約
  - term/TM の非MD制限マップ
```

---

*最終更新: 2026-04-11*
