import { App, DataAdapter } from "obsidian";
import Server from "./server";

export let PLUGIN_DIR: string;
export let SYNC_DLOG_PATH: string;
export let SYNC_DATA_PATH: string;
export let HEAD_COMMIT_PATH: string;
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

	// Other installed plugins' folders hold local, per-install state -- API
	// keys/tokens, device-specific caches, BRAT's tracked-beta-plugin list --
	// that should never leave the device it was set up on. Only the shared,
	// non-secret parts of .obsidian (themes, snippets, hotkeys, appearance)
	// are synced by default.
	DEFAULT_IGNORE = `
${app.vault.configDir}/plugins

${app.vault.configDir}/*.json
`;
}
