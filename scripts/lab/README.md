# mdait Lab — mdait を実際に走らせて確かめる実験場

```bash
node scripts/lab/lab.mjs --help
```

検証の道具はここ1つに束ねてある（旧 `debug-ipc` / `explore-sweep` / `byok-shim` / `ux-lab`）。
**入口は1つ、命令の経路は1つ（ファイル IPC）、AI の偽物は1つ、結果の形も1つ。**
違うのはホストだけで、`--host headless | code-server | desktop` の1語で切り替わる。

```bash
node scripts/lab/lab.mjs up --ai echo --reset   # 実験場を用意する
node scripts/lab/lab.mjs run mdait.sync          # コマンドを叩く。要約が返る
node scripts/lab/lab.mjs down                    # 片付ける
```

作業場は既定で `/tmp/mdait-lab/ws`（`MDAIT_LAB_DIR` で変えられる）。**リポジトリの中は既定にしない**ので、
何をしても `git status` は汚れない。

規模のある見本サイト（対訳49ファイル）で取り込みを試すときは `lab site` で書き出してから、その場所を
作業場として指す。**`/tmp/mdait-lab` の下には置かない** — その下は使い捨てと見なされ、原稿が単体テストの
見本で上書きされる。

```bash
node scripts/lab/lab.mjs site --markers external      # /tmp/mdait-site に書き出す
# 対象言語を足すなら（足した言語は一部のページにしか訳文が無い）:
#   node scripts/lab/lab.mjs site --markers external --extra-langs ko
node scripts/lab/lab.mjs hugo --save /tmp/before.json  # 取り込む前に建てて、出力の指紋を取る
node scripts/lab/lab.mjs up --ws /tmp/mdait-site --ai agent --agent-model haiku
node scripts/lab/lab.mjs run mdait.adopt.run
node scripts/lab/lab.mjs hugo --baseline /tmp/before.json  # 建て直して、何が変わったかを見る
```

見本サイトには静的サイトジェネレータ（Hugo）の最小設定が同梱してある。`lab hugo` は
それを建てて、通るかと、出力がどう変わったかを出す。**Hugo 本体はリポジトリに入れていない** —
PATH か `MDAIT_HUGO_BIN` から探し、無ければ「試せなかった」として素通りする（CI では必須にしない）。

## 中身

| 場所 | 役割 |
|---|---|
| `lab.mjs` | 入口。動詞（up / run / shot / ai / cancel / status / reset / site / hugo / report / down）と段取り |
| `lib/` | セッション・IPC・作業場・run 記録・要約づくり |
| `lib/site-content.mjs` | 規模のある見本サイトの原稿（対訳49ファイル）。`lab site` が書き出す |
| `lib/site-hugo.mjs` | 見本サイトを Hugo で建てる足場（設定・レイアウト・ビルド・出力の指紋）。`lab hugo` が使う |
| `hosts/` | headless（vscode モックの上で常駐）／code-server（ブラウザ版）／desktop（本物）／コマンド対応表 |
| `ai/` | OpenAI 互換のローカル受け皿。echo / live / script / replay / agent |
| `ui/` | Playwright で画面を触る・撮る（code-server のとき） |
| `scenarios/` | sweep（決定的な総なめ・判定する）／probe（頑健性の観察・判定しない）／merge（合流で状態が消えないか・VS Code も AI も使わない） |
| `vscode-shim.js` | headless 用の vscode モック（`src/test/unit/__mocks__` を増補） |

## 入口の別名

```bash
npm run test:explore     # = lab sweep    決定的スイープ。CI で常時走る
npm run test:byok:e2e    # = lab regress  録音の再生。CI で常時走る
npm run test:byok        # AI 受け皿（shim）自身の単体テスト
```

## 詳しい使い方

`.claude/skills/mdait-lab/` の `mdait-lab` スキルを読む。何をするときにどれを使うか、実測して
分かっていること、落とし穴、判定の規律がまとまっている。決定の経緯は `docs/adr.md` の
ADR-260823-01 / -02 / -03、段階の計画は `docs/roadmaps/roadmap-v02_lab-consolidation.md`。
