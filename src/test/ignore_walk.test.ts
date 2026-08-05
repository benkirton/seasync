import { describe, expect, test } from "bun:test";
import { initConfig } from "../config";
import { MODE_DIR, MODE_FILE } from "../server";
import { SyncController, type NodeChange } from "../sync/controller";
import { SyncNode } from "../sync/node";

// Checking ignore patterns against the parser alone is misleading: pull() bails
// at Step 0 on any denied path and returns *before* it fans out to children, so
// a denied folder prunes its whole subtree. A `!` negation under such a folder
// looks like it works when tested against the parser in isolation, but the walk
// never reaches the path to evaluate it. These tests drive the real pull().

function makeFs() {
	const files = new Map<string, string>();
	const dirs = new Set<string>([""]);
	const norm = (p: string) => {
		while (p.startsWith("/")) p = p.slice(1);
		while (p.endsWith("/")) p = p.slice(0, -1);
		return p;
	};
	const adapter: any = {
		async write(p: string, d: unknown) { files.set(norm(p), typeof d === "string" ? d : ""); },
		async append(p: string, d: unknown) { files.set(norm(p), (files.get(norm(p)) ?? "") + (typeof d === "string" ? d : "")); },
		async exists(p: string) { return files.has(norm(p)) || dirs.has(norm(p)); },
		async remove(p: string) { files.delete(norm(p)); },
		async rename(a: string, b: string) { files.set(norm(b), files.get(norm(a))!); files.delete(norm(a)); },
		async mkdir(p: string) { dirs.add(norm(p)); },
		async rmdir(p: string) { dirs.delete(norm(p)); },
		async list(p: string) {
			const pre = norm(p) === "" ? "" : norm(p) + "/";
			return {
				files: [...files.keys()].filter((k) => k.startsWith(pre)),
				folders: [...dirs].filter((k) => k && k.startsWith(pre)),
			};
		},
		async read(p: string) { return files.get(norm(p)) ?? ""; },
		async readBinary(p: string) { return new TextEncoder().encode(files.get(norm(p)) ?? "").buffer; },
		async stat(p: string) {
			const k = norm(p);
			if (files.has(k)) return { type: "file", size: files.get(k)!.length, ctime: 0, mtime: 0 };
			if (dirs.has(k)) return { type: "folder", size: 0, ctime: 0, mtime: 0 };
			return null;
		},
	};
	const app: any = {
		vault: {
			configDir: ".obsidian",
			adapter,
			getAbstractFileByPath: (p: string) => (norm(p) === "" ? { children: [] } : null),
		},
	};
	return { files, dirs, adapter, app };
}

const dir = (name: string, id: string): any => ({ id, mode: MODE_DIR, mtime: 1700000000, name });
const file = (name: string, id: string): any => ({ id, mode: MODE_FILE, mtime: 1700000000, name, size: 7, modifier: "t" });

// Remote tree: .obsidian/{hotkeys.json, workspace.json, plugins/dataview/data.json}
const tree: Record<string, any> = {
	root: { dirents: [dir(".obsidian", "obs"), file("note.md", "blk")], type: 3, version: 1 },
	obs: { dirents: [file("hotkeys.json", "blk"), file("workspace.json", "blk"), dir("plugins", "plugs")], type: 3, version: 1 },
	plugs: { dirents: [dir("dataview", "dv")], type: 3, version: 1 },
	dv: { dirents: [file("data.json", "blk")], type: 3, version: 1 },
	blk: { block_ids: ["b1"], size: 7, type: 1, version: 1 },
};
const server: any = {
	getFs: async (id: string) => [null, tree[id] ?? null],
	getBlock: async () => new TextEncoder().encode("CONTENT").buffer,
};

async function pullAll(userIgnore: string) {
	const fs = makeFs();
	initConfig(fs.app, server, "seasync");
	const sync = new SyncController(fs.adapter, { ignore: userIgnore, account: "t" } as any);
	await fs.adapter.write(".obsidian/plugins/seasync/sync_dlog", "");
	await fs.adapter.write(".obsidian/plugins/seasync/sync_data", "");
	const root = await SyncNode.deserialize("", { prev: null, children: {} });
	const changes: NodeChange[] = [];
	await sync.pull(changes, "", root, dir("", "root"));
	return [...fs.files.keys()].filter((k) => !k.startsWith(".obsidian/plugins/seasync"));
}

describe("what a real pull() actually writes to disk", () => {
	test("notes, hotkeys and appearance land; workspace and plugin data do not", async () => {
		const written = await pullAll("");
		expect(written).toContain("note.md");
		expect(written).toContain(".obsidian/hotkeys.json");
		expect(written).not.toContain(".obsidian/workspace.json");
		expect(written).not.toContain(".obsidian/plugins/dataview/data.json");
	});

	test("a denied FOLDER prunes its subtree -- negation underneath cannot re-include", async () => {
		// Reads as though it should re-include dataview's settings, and the
		// parser agrees in isolation. The walk never gets there.
		const written = await pullAll("!.obsidian/plugins/dataview/data.json");
		expect(written).not.toContain(".obsidian/plugins/dataview/data.json");
	});

	test("negation DOES work for a denied file, whose parent folder is still walked", async () => {
		// .obsidian itself is not denied, so pull() descends into it and the
		// per-file rules are evaluated -- unlike the plugins case above.
		const written = await pullAll("!.obsidian/workspace.json");
		expect(written).toContain(".obsidian/workspace.json");
	});
});
