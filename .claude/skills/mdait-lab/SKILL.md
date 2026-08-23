---
name: mdait-lab
description: "mdait の動作を自分で確かめるための実験場。1つの入口（scripts/lab/lab.mjs）から、3つのホスト（headless / ブラウザ版 VS Code / デスクトップ版 VS Code）で mdait のコマンドを実際に走らせ、AI の相手も選べる（決定的な偽物・自分で答える・意地悪な台本・録音の再生・claude を翻訳役に起動）。Use when: debugging or verifying any mdait command end-to-end, hunting behavior/UX regressions, verifying sync idempotency, running multi-step E2E scenarios (sync → trans → TM → revise), inspecting or improving prompt templates, reproducing LLM failure modes (429/500/timeout/malformed JSON), taking screenshots of the extension UI, running trans without an API key, or when test:explore / test:byok:e2e fails."
---

# mdait Lab — mdait を実際に動かして確かめる

推測で結論を書かないための道具。**入口は1つ**、**命令の書き方は3ホストで同じ**、**結果は run ディレクトリに残る**。

```bash
node scripts/lab/lab.mjs --help
```

## まず3行

```bash
node scripts/lab/lab.mjs up --ai echo --reset   # 実験場を用意する（既定は headless ホスト）
node scripts/lab/lab.mjs run mdait.sync          # コマンドを叩く。結果の要約が返る
node scripts/lab/lab.mjs down                    # 片付ける
```

`up` を忘れても `run` が既定（headless ＋ echo ＋ `/tmp` のワークスペース）で勝手に起こす。
ワークスペースは**リポジトリの外**（`/tmp/mdait-lab/ws`）に作られるので、何をしても `git status` は汚れない。

## どれを使うか

| 確かめたいこと | ホスト | AI | 目安 |
|---|---|---|---|
| sync の冪等性・マーカーの整合・need の一生 | headless | `none` | 数秒。AI を通らないので完全に決定的 |
| trans / tm / term / ai-review の機構 | headless | `echo` | 数秒。費用なし |
| 実際に何を送っているか / 壊れた答えへの耐え方 | headless | `live` / `script` | 観察と注入 |
| 指示文の改稿を比べる | headless | `agent` | **実費がかかる**。対象は1〜3ファイル |
| 回帰（指示文の組み立てが変わっていないか） | headless | `replay` | `lab regress` の1行 |
| ツリー・CodeLens・通知・ダイアログの見え方 | code-server | `echo --delay` | 設営に数分（初回のみ） |
| 本物の `vscode.lm` / ブレークポイント | desktop | `none` | 手元の PC でのみ |

**迷ったら headless ＋ echo。** それで足りない理由が言えるときだけ、他を選ぶ。

## 動詞

| 動詞 | すること |
|---|---|
| `up` | ホストと AI の受け皿を起こし、ワークスペースを用意する |
| `run <mdait.コマンド> [引数…]` | コマンドを叩き、**要約**を返す（全文は run ディレクトリ） |
| `shot <名前>` | 画面を撮る（code-server ホストのみ） |
| `ai wait｜digest｜reply｜stats` | AI の受け皿とやり取りする（`live` モードで使う） |
| `status` | 今どうなっているかを1画面で出す |
| `reset` | ワークスペースを作り直す（ホストは落とさない） |
| `report` | run ディレクトリから `report.md` を組み立てる |
| `down` | 片付ける |

## プリセット（動詞の組み合わせ。独自実装は持たない）

| プリセット | 中身 | 主なオプション |
|---|---|---|
| `lab sweep` | 決定的スイープ（P1〜P8）。FAIL があれば exit 1 | `--only P1,P5` / `--verbose` / `--keep` |
| `lab probe` | 頑健性プローブ（S0〜S14）。判定せず観察し、前回 run と比べる | `--only S3,S13` / `--diff <run>` / `--time` |
| `lab regress` | 録音の再生。LLM 0回。食い違えば exit 1 | `--replay <ファイル>` |
| `lab prompt` | `agent` モードで走らせて指示文を比べる（未実装） | — |
| `lab ux` | code-server を起こして mdait ビューを開き、初期状態を撮る（未実装） | — |

どの段取りも `--dry` を付けると、実行せずに**「実際には何をしているのか」だけ**を出す。
プリセットは低レベル動詞の組み立てしか持たないので、`--dry` の出力がそのまま中身の説明になる。

`npm run test:explore`（= `lab sweep`）と `npm run test:byok:e2e`（= `lab regress`）は
**名前のまま残っていて、CI で常時走る**。ワークスペースがリポジトリの外にあるので、CI で走らせても
何も汚さない。

## 実測して分かっていること

推測ではない。**同じことを調べ直す前にここを見る。**

| 事実 | 効いてくる場面 |
|---|---|
| ユニットは逐次、並列はファイル単位（`trans.concurrency` 既定3・上限8） | 速くしたいとき。AI 側の並列度は上限にならない |
| 3ファイル9ユニット＝12往復・28.4秒（フロントマターの `title` も1往復ずつ） | 対象を絞る目安 |
| 503 と 429 は約2秒おいて送り直され、翻訳は完走する | 耐性の確認。ただし送り直しは `ai-stats.log` に現れない（1回分にまとめられ、所要時間だけ伸びる） |
| 409 は送り直されず、その場で `outcome: "failed"` | replay の不一致が「失敗」として出る理由 |
| コードブロックは `__CODE_BLOCK_PLACEHOLDER_n__` に置換されて送られる | 答えでこの目印をそのまま返さないと本文が落ちる |
| `SelectionState` は初期状態が空 | 全ペアを選んでからでないと sync が何もしない（lab が自動でやる） |
| sync の `totalModified` は**訳文の内容の変更**を数える | 原文を変えて `need:revise` が付くのは modified に入らない。正常 |
| commands 層はタイマーと watcher を残す | プロセスは自然終了しない。だからホストは常駐で、`down` で明示的に落とす |
| mdait は `/v1/models` を叩かない | 実装はあるが、検証では使われない |

## 落とし穴

- **`pkill -f` で広く殺さない。** コマンド行に文字列が入るので自分のシェルまで巻き込む。`lab down` を使う。
- **code-server の起動をパイプ（`| head` など）に繋がない。** サーバーごと死ぬ。
- **desktop はシステム版と同じバージョンの VS Code を避ける。** 同バージョンだと mutex 転送で既存インスタンスに渡り、`MDAIT_DEBUG_IPC` が伝わらず ready にならない（保険として `.ipc-enabled` ファイルも置いている）。
- **`--ai live` の待ち時間はそのまま HTTP のタイムアウトに乗る。** 考えている間に mdait が諦めないよう `ai.openai.timeoutSec` を長めにする（`lab up` が既定で長めにする）。
- **`--ws repo` を使ったときだけ**、リポジトリ内のワークスペースを書き換える。lab が終了時に戻すが、強制終了したら `git checkout -- src/test/unit/workspace/.mdait/mdait.json` を自分でやる。
- **サンプルの `child2_1` / `child2_2` は title の接頭辞が衝突する。** 絞り込みは title の部分一致ではなく**パスの厳密一致**で行う。

## 判定の規律（いちばん大事。狼少年を避ける）

- 逸脱は必ず**単独の再現手順**にしてから報告する。
- **純 sync（AI 非使用）で出た逸脱＝本物の製品バグ。偽の訳文が絡むもの＝偽物の限界**（実 LLM が要る）。
  この2つを混ぜない。断定しない。`sweep` は前者を FAIL、後者を INFO にしている。踏襲する。
- 収束・振動・成長は複数回まわして確かめる（例: sync を4回まわして byte 差分を追い、無限に増えるのか
  1回遅れなのかを見極める）。
- 根本原因は「トレースを1点ずつ挿して」データで確定してから直す。推測で直さない。
- 「動いた」と書くのは、実際に動かして出力を見たときだけ。

## 成果物の作法

- findings は「ファイル別・重大度・単独 repro 手順・本物/偽物の分類」で1本にまとめ、チャットには要約だけ出す。
- 本物のバグは**根本修正 ＋ 単体回帰テスト**（`src/test/unit/...` に固定）＋ **シナリオへのアサーション追加**。
- 指示文を変えたら `lab regress` を回す。落ちたら**録り直すか変更を戻すかを決めてから**進む。
  黙って録音を上書きしない — 何が変わったのかを先に説明できるようにする。
- `npm test` と `lab sweep` を両方緑にしてからコミットする。

## もっと詳しく

- ホストごとの事情・設営・困ったときの対処 → [references/hosts.md](references/hosts.md)
- AI の相手の選び方と作法 → [references/ai-modes.md](references/ai-modes.md)
- IPC の規約とコマンド一覧 → [references/ipc.md](references/ipc.md)
- シナリオのパターン集（P1〜P12） → [references/patterns.md](references/patterns.md)
- シナリオの足し方（sweep / probe の広げ方） → [references/scenarios.md](references/scenarios.md)

## リポジトリ側の参照

- テスト戦略の中での位置づけ: `docs/design/test.md`
- 決定の経緯: `docs/adr.md` の ADR-260823-01 / -02 / -03、ADR-260822-03
- 段階の計画: `docs/roadmaps/roadmap-v02_lab-consolidation.md`
- プロバイダ層の実装: `src/infra/llm/providers/openai-provider.ts`、`src/infra/llm/retry.ts`
- 指示文のテンプレート: `src/prompts/defaults.ts`（分割の考え方は `docs/design/prompt.md`）
- IPC の実装（正）: `src/infra/debug/debug-command-handler.ts`
