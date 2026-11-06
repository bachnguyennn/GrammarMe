#!/bin/sh
# GrammarMe companion installer (macOS and Linux).
#
#   curl -fsSL https://bachnguyennn.github.io/GrammarMe/companion/install.sh | sh
#
# What it does, and nothing else:
#   1. Downloads the companion from the latest GrammarMe release on GitHub, built in public by
#      .github/workflows/release.yml from the tagged source:
#        - grammarme-companion.mjs (~90 KB) if Node.js 22.6+ is installed, or
#        - a standalone executable with Node built in (~40 MB download) if it isn't.
#   2. Checks it against the release's SHA256SUMS and stops if it doesn't match.
#   3. Runs its `install` command. That copies it to ~/.config/grammarme/bin and registers it with
#      Chrome, Chromium, Edge and Brave as the native messaging host com.grammarme.chatgpt, for
#      GrammarMe's extension only.
# It needs no sudo, changes nothing outside your home folder, and runs nothing in the background.
# Remove it with:  ~/.config/grammarme/bin/grammarme-companion uninstall
#   (or, for the Node version:  node ~/.config/grammarme/bin/grammarme-companion.mjs uninstall)
#
# Extra arguments go to `install` (e.g. --browser chrome). For tests, GRAMMARME_DOWNLOAD_BASE may
# point at a local server on 127.0.0.1; any other non-HTTPS address is refused.
set -eu

BASE="${GRAMMARME_DOWNLOAD_BASE:-https://github.com/bachnguyennn/GrammarMe/releases/latest/download}"
REPO_PAGE="https://github.com/bachnguyennn/GrammarMe"
GUIDE="https://bachnguyennn.github.io/GrammarMe/install.html#chatgpt"

say() { printf '%s\n' "$*"; }
fail() { printf 'GrammarMe installer: %s\n' "$*" >&2; exit 1; }

case "$BASE" in
  https://*) CURL_PROTO="=https" ;;
  http://127.0.0.1:*|http://localhost:*) CURL_PROTO="=http,https" ;;
  *) fail "GRAMMARME_DOWNLOAD_BASE must be an https:// address (or 127.0.0.1 for tests)." ;;
esac

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "this installer is for macOS and Linux. Windows isn't supported yet: $GUIDE" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "unsupported processor $(uname -m)." ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is needed to download the companion."
if command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
else fail "shasum or sha256sum is needed to verify the download."; fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t grammarme)"
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() { # fetch <asset>
  curl -fsSL --proto "$CURL_PROTO" --retry 2 "$BASE/$1" -o "$TMP/$1"
}
verify() { # verify <asset>
  expected="$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS")"
  [ -n "$expected" ] || fail "$1 isn't listed in the release's SHA256SUMS."
  actual="$(cd "$TMP" && $SHA "$1" | awk '{ print $1 }')"
  [ "$expected" = "$actual" ] || fail "$1 doesn't match its checksum. Nothing was installed."
}

say "GrammarMe companion installer"
fetch SHA256SUMS || fail "couldn't download the release from $BASE. Is there a published release? See $REPO_PAGE/releases"

# Prefer the tiny Node version when a new enough Node is available.
NODE_OK=no
if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' 2>/dev/null; then
  NODE_OK=yes
fi

if [ "$NODE_OK" = yes ]; then
  say "Using your Node.js $(node --version) (small download)."
  fetch grammarme-companion.mjs || fail "couldn't download grammarme-companion.mjs."
  verify grammarme-companion.mjs
  node "$TMP/grammarme-companion.mjs" install "$@"
else
  ASSET="grammarme-companion-$OS-$ARCH"
  say "Node.js 22.6+ not found: downloading the standalone companion for $OS-$ARCH (about 40 MB)."
  fetch "$ASSET.tar.gz" || fail "no standalone build for $OS-$ARCH in this release. Install Node.js 22.6 or newer (https://nodejs.org) and run this command again."
  verify "$ASSET.tar.gz"
  tar -xzf "$TMP/$ASSET.tar.gz" -C "$TMP"
  chmod 755 "$TMP/$ASSET"
  "$TMP/$ASSET" install "$@"
fi

say ""
say "Installed. Next: open the GrammarMe button in Chrome's toolbar and choose Continue with ChatGPT."
