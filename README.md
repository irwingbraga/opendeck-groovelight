# Groovelight for OpenDeck

Control [Groovelight](https://github.com/irwingbraga/groovelight), the music player, from a Stream Deck: play and pause, skip, see what is playing with its cover, and play a playlist, an album, an artist or the Album of the Day with one key.

A plugin for [OpenDeck](https://github.com/nekename/OpenDeck), the open source Stream Deck software, on macOS and Windows.

## Keys

| Key | Shows | Pressing it |
|---|---|---|
| Play / Pause | Play or pause over the cover of the song playing | Plays or pauses |
| Next, Previous | Their icons | Skips to the next or previous song |
| Now Playing | The cover, title and artist, with a pause badge when paused | Plays or pauses |
| Play | The cover of the album (or of the first song a search finds), else the name of the playlist or artist; a badge when shuffled | Plays the playlist, album, artist or search, shuffled when chosen |
| Album of the Day | Home's pick of the day with its cover (or the Song or Artist of the Day) | Plays it |

The keys follow the app: playing from Groovelight's window, the keyboard or a phone updates them within a second. When Groovelight is not running, the keys show it, and checking them never starts it; pressing a key does start it.

## Requirements

- [OpenDeck](https://github.com/nekename/OpenDeck).
- [Node.js](https://nodejs.org) 22 or later (OpenDeck runs the plugin with it; on the Mac, Homebrew's `node` works).
- Groovelight. Covers on the keys need 0.9.7 or later; with an older version the keys work without them.

## Install

macOS:

```bash
git clone https://github.com/irwingbraga/opendeck-groovelight.git
cd opendeck-groovelight
./install.sh
```

Then restart OpenDeck.

Windows: build the package on any computer with `./pack.sh` (or download it from the releases), then in OpenDeck open Plugins, **Install from file** and pick `dev.irwingbraga.groovelight.deck-<version>.streamDeckPlugin`.

## Use

Drag the keys from the **Groovelight** category onto your deck. Play and Album of the Day have settings: click the key to open them.

- **Play**: choose a playlist from the list (press **Refresh playlists** after making one), or type an album (with its artist when several albums share the title), an artist, or words to search for. Names match ignoring case and accents, and part of a name is enough when only one thing matches. **Key label** replaces the name shown on the key.
- **Album of the Day**: choose the Album, Song or Artist of the Day. The pick is the same all day, as on Home.

## How it works

```
OpenDeck <-- websocket --> plugin (Node.js, main.js) --> Groovelight
                                                         macOS: the groovelight command line tool (Mach port)
                                                         Windows: the app's named pipe
```

One Node.js process with no dependencies. On the Mac it runs the command line tool inside the app (`Groovelight.app/Contents/Helpers/groovelight`, no need to install it in your `PATH`) with `--json`; on Windows it talks to the app's named pipe directly, the way the tool does. The play state is checked once a second, after making sure the app is running (`pgrep` on the Mac, the pipe on Windows), so the deck never launches it. Each cover is fetched once, as a 256-pixel JPEG, when the song changes. Keys are drawn as SVG images with the cover inside.

## Troubleshooting

- **The keys say Groovelight while it is open.** On the Mac, check that `/Applications/Groovelight.app` exists (or `~/Applications`). On Windows, the plugin finds the app's pipe for the default library only.
- **No covers.** Update Groovelight to 0.9.7 or later.
- **A Play key flashes a warning.** Groovelight could not find what it should play (the name matches nothing, or several things): open its settings and be more specific. The plugin log says why.
- Plugin log: `~/Library/Logs/opendeck/plugins/dev.irwingbraga.groovelight.deck.sdPlugin.log` on the Mac, the `plugins` folder of OpenDeck's logs on Windows.

## Development

```
dev.irwingbraga.groovelight.deck.sdPlugin/   the plugin: manifest, main.js, settings pages, icons
install.sh                                   copy the plugin into OpenDeck (macOS, Linux)
pack.sh                                      build the package for "Install from file"
```

Edit the plugin here, run `./install.sh`, then restart OpenDeck. To try it against a development build of Groovelight, put `{"cli": "/path/to/Groovelight.app/Contents/Helpers/groovelight"}` in `dev.irwingbraga.groovelight.deck.sdPlugin/local.json` (Windows: `{"pipe": "<pipe name>", "app": "<path of Groovelight.exe>"}`) and install with `./install.sh --dev`.

## License

MIT
