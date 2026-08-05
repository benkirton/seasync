import { describe, expect, test } from "bun:test";
import * as IgnoreParser from "gitignore-parser";
import { DEFAULT_IGNORE, initConfig } from "../config";

// Pins exactly which parts of .obsidian sync. Getting this wrong leaks other
// plugins' local state (API keys, BRAT's tracked-beta list) into the repo --
// which is what caused BRAT to arrive pre-populated on a fresh device.
//
// Note this is the *pattern* layer only. pull() additionally prunes the walk at
// any denied folder and never descends into it, so nothing under
// .obsidian/plugins can be re-included by a negation -- see the walk test in
// ignore_walk.test.ts.

const app = { vault: { configDir: ".obsidian", adapter: {} } } as any;

function compile(userPattern = "") {
	initConfig(app, {} as any, "seasync");
	return IgnoreParser.compile(DEFAULT_IGNORE + "\n" + userPattern);
}

describe("DEFAULT_IGNORE", () => {
	const ig = compile();
	const synced = (p: string) => !ig.denies(p);

	test("syncs notes", () => {
		expect(synced("notes/todo.md")).toBe(true);
		expect(synced("attachments/img.png")).toBe(true);
	});

	test("syncs themes and snippets", () => {
		expect(synced(".obsidian/themes/Minimal/theme.css")).toBe(true);
		expect(synced(".obsidian/snippets/custom.css")).toBe(true);
	});

	test("syncs hotkeys and appearance", () => {
		expect(synced(".obsidian/hotkeys.json")).toBe(true);
		expect(synced(".obsidian/appearance.json")).toBe(true);
	});

	test("does not sync per-device layout or the enabled-plugin list", () => {
		expect(synced(".obsidian/workspace.json")).toBe(false);
		expect(synced(".obsidian/workspace-mobile.json")).toBe(false);
		expect(synced(".obsidian/community-plugins.json")).toBe(false);
		expect(synced(".obsidian/core-plugins.json")).toBe(false);
		expect(synced(".obsidian/app.json")).toBe(false);
		expect(synced(".obsidian/graph.json")).toBe(false);
	});

	test("does not sync any plugin's code or data -- including its own", () => {
		for (const p of [
			".obsidian/plugins",
			".obsidian/plugins/dataview/main.js",
			".obsidian/plugins/dataview/data.json",
			".obsidian/plugins/obsidian42-brat/data.json",
			".obsidian/plugins/seasync/data.json",
			".obsidian/plugins/seasync/sync_data",
			".obsidian/plugins/seasync/tmp/dl-0",
		]) {
			expect(synced(p)).toBe(false);
		}
	});

	test("a user ignore rule still overrides the defaults", () => {
		const custom = compile("!.obsidian/workspace.json\nnotes/private");
		expect(custom.denies(".obsidian/workspace.json")).toBe(false);
		expect(custom.denies("notes/private/secret.md")).toBe(true);
	});
});
