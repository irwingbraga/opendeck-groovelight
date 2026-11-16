#!/bin/bash
# Copies the plugin into OpenDeck's plugins folder (macOS and Linux). On Windows, install the zip from `./pack.sh`
# with OpenDeck's "Install from file" instead.
# A copy, not a symlink: OpenDeck refuses to serve settings pages through a symlink outside its config folder.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="dev.irwingbraga.groovelight.deck.sdPlugin"
case "$(uname)" in
	Darwin) DEST="$HOME/Library/Application Support/opendeck/plugins" ;;
	Linux) DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/plugins" ;;
	*) echo "Use ./pack.sh and OpenDeck's Install from file on this system." >&2; exit 1 ;;
esac
mkdir -p "$DEST/$UUID"
# local.json (development overrides) is copied only with --dev.
EXCLUDE=(--exclude local.json)
[ "$1" = "--dev" ] && EXCLUDE=()
rsync -a --delete "${EXCLUDE[@]}" "$HERE/$UUID/" "$DEST/$UUID/"
echo "Installed to $DEST/$UUID"
echo "Restart OpenDeck (or reload the plugin) to load it."
