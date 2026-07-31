# Seasync

An [Obsidian](https://obsidian.md/) plugin for synchronizing notes across devices using [Seafile](https://www.seafile.com/), an open-source, self-hosted file sync and share solution.

Originally forked from [conql/obsidian-seafile](https://github.com/conql/obsidian-seafile), continued as `obsidian-seafile-continued` by [@ryanravn](https://github.com/ryanravn), and now developed here as **Seasync**.

## What's different in this fork

- **Encrypted repositories** are supported (enc_version 2 and 4). Passphrase is prompted on repo selection and on Obsidian restart, never stored in plaintext.
- **Manual sync**: a "Sync now" button in settings and a "Seafile: Sync now" command (assignable to a hotkey) trigger an immediate sync without waiting for the interval tick.
- **Conflicted copies**: if the same file changes on two devices between syncs, the newer version is kept and the older one is saved alongside it as a conflicted copy instead of being silently discarded.
- **Login-expiry recovery**: an expired/revoked auth token stops sync with a clear notice instead of retrying forever.

## Features

- Supports both desktop and mobile.
- Uses Seafile's internal syncing API for full synchronization (delta upload/download).
- Fast sync speed, performs well even on low-end Android phones.
- End-to-end encrypted libraries (v2 and v4).

## Installation

Not (yet) in the Community Plugins store. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the "BRAT" community plugin from Obsidian's plugin browser.
2. In BRAT's settings, "Add beta plugin", enter `benkirton/seasync`.
3. Enable "Seasync" in Community plugins.

BRAT will track new releases of this repo automatically.

## Usage

1. Open the plugin settings.
2. Enter the URL of your Seafile server and log into your account.
3. Choose the repository you want to sync. If it's encrypted, enter the passphrase when prompted.
4. *Optional*: configure an ignore pattern. The syntax loosely follows [gitignore](https://git-scm.com/docs/gitignore). Test it before relying on it. The plugin folder and Obsidian configuration are always ignored.
5. Click "Enable" to start syncing.
6. The plugin will now sync at the configured interval.

To trigger a sync immediately, click "Sync now" in the settings, or run "Seafile: Sync now" from the command palette (assign it a hotkey if you use it often).

Per-file sync status is shown next to file names in the explorer.

## Notes

1. **Use it at your own risk.** This plugin is still under development. Keep backups of anything important.
2. **No large files.** Due to limitations of Obsidian's API, downloading or uploading files larger than ~50 MB may take a long time or crash the app. Don't sync large attachments through this plugin.
3. **Clear vault** if you hit issues. The action removes all local files and resyncs from the server.
4. **Don't interrupt syncing**, especially during upload (upload icon shown). Closing Obsidian mid-sync can corrupt data on the server.
5. **Hidden files** (anything starting with a dot, e.g. `.obsidian`) are not tracked continuously due to API limits. They are only updated at plugin startup.

## Development

Toolchain is [bun](https://bun.sh), pinned via [mise](https://mise.jdx.dev) (see `.mise.toml`). No npm/pnpm needed.

```sh
mise install    # installs the pinned bun version
bun install     # install dependencies
bun run dev     # watch build, copies output into vault/ for the test vault
bun run build   # typecheck + production build
bun test        # unit tests
```

## Contribution & Support

Open a [GitHub issue](https://github.com/benkirton/seasync/issues) for bugs, feature requests, or questions.

## Credits

Original plugin by [@conql](https://github.com/conql). Community continuation by [@ryanravn](https://github.com/ryanravn). This fork (Seasync) maintained by [@benkirton](https://github.com/benkirton).
