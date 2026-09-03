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
| 改訂の出力形式を選び直す | （ホスト不要） | `agent` / 自前の口 | `lab bench-revise`。**判定の筋道だけなら `--self-test` で 0 回** |
| 回帰（指示文の組み立てが変わっていないか） | headless | `replay` | `lab regress` の1行 |
| ツリー・CodeLens・通知・ダイアログの見え方 | code-server | `echo --delay` | 設営に数分（初回のみ）。一通りなら `lab ux` |
| 本物の `vscode.lm` / ブレークポイント | desktop | `none` | 手元の PC でのみ |

**迷ったら headless ＋ echo。** それで足りない理由が言えるときだけ、他を選ぶ。

## 動詞

| 動詞 | すること |
|---|---|
| `up` | ホストと AI の受け皿を起こし、ワークスペースを用意する |
| `run <mdait.コマンド> [引数…]` | コマンドを叩き、**要約**を返す（全文は run ディレクトリ） |
| `shot <名前>` | 画面を撮る（code-server ホストのみ。**文字にも落とす**なら `lab ux`／`ui/driver.mjs` の `ask`） |
| `ai wait｜digest｜reply｜stats` | AI の受け皿とやり取りする（`live` モードで使う） |
| `status` | 今どうなっているかを1画面で出す |
| `cancel` | 走っている最中のコマンドを止める（headless のみ。別のシェルから叩く） |
| `reset` | ワークスペースを作り直す（ホストは落とさない） |
| `site` | 規模のある見本サイト（対訳47ファイル）を書き出す。`--out`（既定 `/tmp/mdait-site`）・`--markers embedded\|external` |
| `report` | run ディレクトリから `report.md` を組み立てる |
| `down` | 片付ける |

## プリセット（動詞の組み合わせ。独自実装は持たない）

| プリセット | 中身 | 主なオプション |
|---|---|---|
| `lab sweep` | 決定的スイープ（P1〜P14）。FAIL があれば exit 1 | `--only P1,P5` / `--verbose` / `--keep` |
| `lab probe` | 頑健性プローブ（S0〜S14）。判定せず観察し、前回 run と比べる | `--only S3,S13` / `--diff <run>` / `--time` |
| `lab regress` | 録音の再生。LLM 0回。食い違えば exit 1 | `--replay <ファイル>` |
| `lab resilience` | 壊れた応答への耐性（9経路 × 8種）。**1周20〜30分・CI 対象外** | `--only R1,R8` / `--nasty N1,N4` |
| `lab prompt` | `agent` モードで走らせて指示文を比べる（未実装） | — |
| `lab bench-revise` | **改訂（revise）の出力形式を比べて数える。** 同じケースを候補ごとに投げ、`transport → envelope → format → apply → health` の5段でどこまで通ったかを出す。**実費（利用枠）がかかる** | `--self-test`（LLM 0回）／ `--model haiku` ／ `--base-url <URL>` ／ `--cases C1,C4` ／ `--variants current,linenum` ／ `--repeat 3` |
| `lab ux` | 実 UI にしか無いもの（ツリーのアイコン・確認ダイアログ・翻訳中の回転・CodeLens・通知）を撮り、**文字にも落とす**。**設営に数分・CI 対象外** | `--only U1,U4` / `--keep` |

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
| **対訳47ファイル（原文24／訳文23）を external ＋実 LLM（haiku）で取り込む＝AI 往復123回・38分40秒**（`lab site` の見本）。内訳は自動承認 81/81・エスカレーション 0・AIアライン訂正 8・用語 検出72／展開2／残り9・TM 62ユニット→122件 | 規模の見積り。**ファイル1本あたり約5往復・約50秒**。数百ファイルへ外挿するときの元の数字 |
| **同じ見本を embedded で取り込むと、AI 往復も件数もほぼ同じ**（往復123回・32分42秒・自動承認 81/81・エスカレーション 0・AIアライン訂正 8・TM 62ユニット→122件・確認待ち5件・CRLF 10本保持）。違ったのは用語だけ（検出65／展開0／残り13） | **マーカーの置き場は取り込みの結果を変えない。** 時間差（6分）は AI の応答のばらつきで、往復数は同数。用語の段だけは AI が返す一覧に依存するので回ごとに動く |
| embedded の取り込みで原稿が変わるのは、**マーカーの追加以外では2種類だけ**（47ファイル中: 無変化7／マーカー追加のみ34／それ以外6）。それ以外6の内訳は、章が移動しただけ3本（AIアライン訂正が効いた）と、訳文に無い章が原文のまま `need:translate` で足された3本 | 「embedded は差分が大きい」の中身。**本文の書き換えではなくマーカーの挿入**。純増した章は `totalAdded` と一致する（新規に作られた訳文2本と合わせて7） |
| 取り込みのあとに確認待ちで残るのは5件だけ（非MD 3本＋訳文だけにある章2件）。どちらも設計どおり（パターン10・3） | 「残っている＝失敗」ではない。件数の内訳を見る |
| 用語の展開で残った9件は、**訳文がまだ無い章から拾った用語**（原文だけのファイル・訳文で落ちている章）。展開できないのが正しい | `term.expand` の残り件数を欠陥と読まない |
| 503・429・500 は約2秒→4秒→8秒で最大3回送り直す。429/503 は完走し、500 は4回目で諦める（14秒） | 耐性の確認。**どの AI 経路でも同じ**。送り直しは `ai-stats.log` に現れない（1回分にまとめられ、所要時間だけ伸びる） |
| 400 は送り直さずその場で失敗。タイムアウトは一時的エラー扱いで送り直し、26秒で諦める | どちらも原稿はまったく変わらない |
| **用語検出・用語展開・TM 登録は、壊れた応答をすべて跳ね返す**（件数0で終わり何も書かない） | 同じ意地悪で**翻訳系5経路だけが壊れる**。壊れ方が経路によって違うことの基準線 |
| 409 は送り直されず、その場で `outcome: "failed"` | replay の不一致が「失敗」として出る理由 |
| コードブロックは `__CODE_BLOCK_PLACEHOLDER_n__` に置換されて送られる | 答えでこの目印をそのまま返さないと本文が落ちる |
| `SelectionState` は初期状態が空 | 全ペアを選んでからでないと sync が何もしない（lab が自動でやる） |
| **確認は2枚立ちはだかる**（フォルダ翻訳の確認 `[No / Cancel / Yes]` → AI 初回利用の説明 `[Cancel / Proceed]`） | 実ホストでは初回利用の説明も出る（headless は `MDAIT_DEBUG_IPC=1` で飛ばす）。並び順でボタンを選ばない |
| フォルダ翻訳の確認は **`message` が空で、文言はすべて `detail`** に入る | ダイアログの文言は `message \|\| detail` で見る |
| 翻訳中は**ファイルの行まで回転アイコンが出る**（`child2_1.md` / `child2_2.md`）。まとめの行の数字も `child (0/9)` → `(1/9)` と進む | 開いている枝しか DOM に無いので、見たい枝を開いてから撮る |
| CodeLens は訳文側が `✨Translate / ✓Mark as Translated / ⎘Source / ⋮More`、原文側が `⎘Target / ⋮More` | 品揃えが変わったら `src/ui/codelens/codelens-provider.ts` を見る |
| sync の `totalModified` は**訳文の内容の変更**を数える | 原文を変えて `need:revise` が付くのは modified に入らない。正常 |
| commands 層はタイマーと watcher を残す | プロセスは自然終了しない。だからホストは常駐で、`down` で明示的に落とす |
| mdait は `/v1/models` を叩かない | 実装はあるが、検証では使われない |
| **`response_format` はどのプロバイダにも送っていない**（JSON モードも json_schema も未使用）。既定の `vscode-lm` には送る口すら無い | 構造化出力の効き目を測るときは、OpenAI 互換の口を直接指すしかない。`claude -p` 経由では測れない |
| 改訂（revise）は**独自形式のパッチを JSON の文字列に詰めて**返させる。指示文自身が "It is NOT a standard unified diff" と断っている | 弱いモデルが落ちる筋。`lab bench-revise` で形式ごとに数えられる |
| **`applySimplePatch` はわざと寛容**（プレフィックスの無い行を文脈行として扱い、アンカーだけで位置を決める戦略も持つ） | 出鱈目なパッチが `ok: true` で当たりうる。「当たったか」だけを見ると原稿を壊す案が満点になる |
| 録音による回帰（`lab regress`、CI 常時）は**新規翻訳の12往復と改訂の5往復**。改訂は当てはめまで見る（当たっていなければ改訂は成立していない） | 指示文の組み立てを変えたらここが落ちる。改訂の録音は `REVISE_EDIT` の編集と一体なので、1文字でも変えると再生が止まる |
| 録音の再生は**順番ではなく中身で引く**（指紋は `model` + `stream` + `messages`） | 並列翻訳でも決定的。ただし system プロンプトを1文字変えれば必ず 409 で落ちる |

## 落とし穴

- **`pkill -f` で広く殺さない。** コマンド行に文字列が入るので自分のシェルまで巻き込む。`lab down` を使う。
- **code-server の起動をパイプ（`| head` など）に繋がない。** サーバーごと死ぬ。
- **desktop はシステム版と同じバージョンの VS Code を避ける。** 同バージョンだと mutex 転送で既存インスタンスに渡り、`MDAIT_DEBUG_IPC` が伝わらず ready にならない（保険として `.ipc-enabled` ファイルも置いている）。
- **`--ai live` の待ち時間はそのまま HTTP のタイムアウトに乗る。** 考えている間に mdait が諦めないよう `ai.openai.timeoutSec` を長めにする（`lab up` が既定で長めにする）。
- **見本サイトの置き場を `/tmp/mdait-lab` の下にしない。** その下は「使い捨て」と見なされ、`--reset` で
  原稿が単体テストの見本に置き換わる（`lib/workspace.mjs` の `isDisposable`）。`lab site` の既定
  （`/tmp/mdait-site`）はそのために外へ出してある。
- **`--ws repo` を使ったときだけ**、リポジトリ内のワークスペースを書き換える。lab が終了時に戻すが、強制終了したら `git checkout -- src/test/unit/workspace/.mdait/mdait.json` を自分でやる。
- **サンプルの `child2_1` / `child2_2` は title の接頭辞が衝突する。** 絞り込みは title の部分一致ではなく**パスの厳密一致**で行う。
- **実 UI を見るときは Playwright の `innerText()` を使わない。** 無い要素を 30 秒待ち続け、その間ほかの
  操作が全部止まる（実測）。`evaluateAll` で一度に読む。詳しくは references/hosts.md。

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
- シナリオの足し方（sweep / probe / ux の広げ方） → [references/scenarios.md](references/scenarios.md)
- 妥当性確認（使い手を演じさせ、直したあとに聞き直す） → [references/validation.md](references/validation.md)

## リポジトリ側の参照

- テスト戦略の中での位置づけ: `docs/design/test.md`
- 決定の経緯: `docs/adr.md` の ADR-260901-02、ADR-260824-03、ADR-260823-01 / -02 / -03、ADR-260822-03
- 段階の計画: `docs/roadmaps/roadmap-v02_lab-consolidation.md`、`docs/roadmaps/roadmap-v03_revise-prompt-optimization.md`
- プロバイダ層の実装: `src/infra/llm/providers/openai-provider.ts`、`src/infra/llm/retry.ts`
- 指示文のテンプレート: `src/prompts/defaults.ts`（分割の考え方は `docs/design/prompt.md`）
- IPC の実装（正）: `src/infra/debug/debug-command-handler.ts`
