import { App, DataAdapter } from "obsidian";
import Server from "./server";

export let PLUGIN_DIR: string;
export let SYNC_DLOG_PATH: string;
export let SYNC_DATA_PATH: string;
export let HEAD_COMMIT_PATH: string;
export let DOWNLOAD_TMP_DIR: string;
export let DEFAULT_IGNORE: string;
export let app: App;
export let adapter: DataAdapter;
export let server: Server;

export function initConfig(app_: App, server_: Server, pluginId: string) {
	app = app_;
	server = server_;
	adapter = app.vault.adapter;
	PLUGIN_DIR = app.vault.configDir + "/plugins/" + pluginId;
	SYNC_DLOG_PATH = PLUGIN_DIR + "/" + "sync_dlog";
	SYNC_DATA_PATH = PLUGIN_DIR + "/" + "sync_data";
	HEAD_COMMIT_PATH = PLUGIN_DIR + "/" + "head_commit";
	// Downloads land here first and are renamed into the vault only once
	// complete, so an interrupted download never leaves a partial file at the
	// real path. Inside PLUGIN_DIR, so DEFAULT_IGNORE already keeps it out of
	// sync scans.
	DOWNLOAD_TMP_DIR = PLUGIN_DIR + "/" + "tmp";

	// What syncs from .obsidian: themes/, snippets/, hotkeys.json and
	// appearance.json. Those are device-agnostic and tedious to redo by hand
	// (especially on mobile), and Obsidian Sync has them on by default too.
	//
	// What doesn't, and why:
	// - .obsidian/plugins/ -- plugin folders hold per-install state: API keys
	//   and tokens, device-specific caches, BRAT's tracked-beta-plugin list.
	//   None of that should leave the device it was set up on. Note Obsidian
	//   gives each plugin a single data.json for its whole config, so there is
	//   no way to sync a plugin's ordinary settings without its secrets.
	// - workspace.json / workspace-mobile.json -- per-device pane layout.
	// - community-plugins.json / core-plugins.json -- the enabled-plugin
	//   lists, meaningless without the plugins themselves.
	//
	// Careful: pull() prunes the walk at any denied *folder* and never descends
	// into it, so a "!" negation under .obsidian/plugins can never take effect,
	// however plausible it looks against the ignore matcher alone. Negations on
	// denied *files* (as below) do work, since .obsidian itself is still walked.
	// See ignore_walk.test.ts.
	DEFAULT_IGNORE = `
${app.vault.configDir}/plugins

${app.vault.configDir}/*.json
!${app.vault.configDir}/hotkeys.json
!${app.vault.configDir}/appearance.json
`;
}
