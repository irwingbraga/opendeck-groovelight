#!/bin/bash
# Builds dist/dev.irwingbraga.groovelight.deck.streamDeckPlugin, a zip OpenDeck installs with "Install from file".
set -e
cd "$(dirname "$0")"
UUID="dev.irwingbraga.groovelight.deck.sdPlugin"
VERSION="$(sed -n 's/.*"Version": "\([^"]*\)".*/\1/p' "$UUID/manifest.json" | head -1)"
mkdir -p dist
OUT="dist/dev.irwingbraga.groovelight.deck-$VERSION.streamDeckPlugin"
rm -f "$OUT"
zip -qr "$OUT" "$UUID" -x "$UUID/local.json" "*.DS_Store"
echo "$OUT"
