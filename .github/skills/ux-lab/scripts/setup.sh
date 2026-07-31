#!/usr/bin/env bash
# mdait UX Lab: code-server + Playwright 環境の構築。詳細は ../SKILL.md 参照。
set -euo pipefail

WORKDIR="${MDAIT_UXLAB_DIR:-/tmp/mdait-uxlab}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "== mdait UX Lab setup =="
echo "WORKDIR: $WORKDIR"
echo "REPO:    $REPO_ROOT"

mkdir -p "$WORKDIR"
cd "$WORKDIR"
[ -f package.json ] || npm init -y > /dev/null

# kerberos のネイティブビルドに必要（入っていれば何もしない）
if [ ! -f /usr/include/gssapi/gssapi.h ]; then
  sudo apt-get install -y -qq libkrb5-dev \
    || echo "WARN: libkrb5-dev を導入できませんでした。kerberos のビルドが失敗する可能性があります"
fi

if [ ! -f "$WORKDIR/node_modules/code-server/out/node/entry.js" ]; then
  echo "-- code-server をインストール（postinstall 無効）--"
  # postinstall は GitHub から ripgrep バイナリを取得しようとして必ず失敗する
  # （このネットワークは npm レジストリのみ許可）ため、scripts を止めて後で手当てする
  npm install --ignore-scripts --unsafe-perm code-server playwright-core

  pushd node_modules/code-server/lib/vscode > /dev/null
  npm install --ignore-scripts --omit=dev --unsafe-perm

  # ripgrep: バイナリのダウンロードを封じ、環境内蔵の rg を流用する
  RG_PKG=node_modules/@vscode/ripgrep
  mkdir -p "$RG_PKG/bin" "$RG_PKG/lib"
  cp "$(command -v rg)" "$RG_PKG/bin/rg"
  echo "process.exit(0)" > "$RG_PKG/lib/postinstall.js"

  echo "-- ネイティブモジュールをビルド（数分かかる）--"
  npm rebuild --unsafe-perm

  pushd extensions > /dev/null
  npm install --ignore-scripts --omit=dev --unsafe-perm
  popd > /dev/null
  popd > /dev/null
else
  echo "-- code-server はインストール済み。スキップ --"
  [ -d node_modules/playwright-core ] || npm install --ignore-scripts playwright-core
fi

echo "-- mdait を vsix にパッケージ --"
cd "$REPO_ROOT"
[ -d node_modules ] || npm ci
npm run bundle:dev
npx vsce package --allow-missing-repository --skip-license -o "$WORKDIR/mdait.vsix"

echo "-- code-server へ拡張をインストール（cs-ext / cs-data は作り直し）--"
rm -rf "$WORKDIR/cs-ext" "$WORKDIR/cs-data"
mkdir -p "$WORKDIR/cs-ext" "$WORKDIR/cs-data" "$WORKDIR/shots"
node "$WORKDIR/node_modules/code-server/out/node/entry.js" \
  --extensions-dir "$WORKDIR/cs-ext" --user-data-dir "$WORKDIR/cs-data" \
  --install-extension "$WORKDIR/mdait.vsix"

echo "== setup 完了。次: bash $SCRIPT_DIR/start.sh =="
