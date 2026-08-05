import { describe, expect, test } from "bun:test";
import { initConfig } from "../config";
import { MODE_FILE, ZeroFs } from "../server";
import { SyncController, type NodeChange } from "../sync/controller";
import { SyncNode } from "../sync/node";
import type { FileSeafDirent } from "../server";

// Regression test: a download interrupted part-way (mobile backgrounding kills
// the network, or the OS suspends/terminates the app) used to leave a partial
// file at the real destination path, already stamped with the *remote's* mtime.
//
// With no `prev` recorded (setPrevAsync only runs after downloadFile returns)
// and prevDirty defaulting to true, the next pull() could not classify that
// file as same/local/remote/merge, so it fell through to "conflict" -- copying
// the partial garbage into conflicts/<stamp>/ and then uploading it. On a large
// library that fired for hundreds of in-flight files at once.
//
// The fix: download into DOWNLOAD_TMP_DIR and rename into place only once every
// block has landed, so an interruption leaves the destination untouched.

const FILE_PATH = "note.md";
const CONTENT = "hello world, this is the full remote content";

const remote: FileSeafDirent = {
	id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	mode: MODE_FILE,
	modifier: "tester",
	mtime: 1700000000,
	name: FILE_PATH,
	size: CONTENT.length,
};

interface FakeFile { data: Uint8Array; mtime: number }

// Minimal in-memory filesystem standing in for Obsidian's DataAdapter.
function makeFakeFs() {
	const files = new Map<string, FakeFile>();
	const dirs = new Set<string>();

	const norm = (p: string) => {
		while (p.startsWith("/")) p = p.slice(1);
		while (p.endsWith("/")) p = p.slice(0, -1);
		return p;
	};
	const toBytes = (data: unknown): Uint8Array => {
		if (typeof data === "string") return new TextEncoder().encode(data);
		const view = data as DataView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	};

	// A real filesystem always has the ancestors of an existing file, so model
	// that -- otherwise exists() on a directory misreports.
	const addParents = (p: string) => {
		const parts = norm(p).split("/");
		parts.pop();
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			dirs.add(cur);
		}
	};

	const adapter = {
		async write(p: string, data: string, opts?: { mtime?: number }) {
			addParents(p);
			files.set(norm(p), { data: toBytes(data), mtime: opts?.mtime ?? 0 });
		},
		async append(p: string, data: string, opts?: { mtime?: number }) {
			const key = norm(p);
			const cur = files.get(key);
			if (!cur) throw new Error("ENOENT: " + key);
			const add = toBytes(data);
			const merged = new Uint8Array(cur.data.length + add.length);
			merged.set(cur.data);
			merged.set(add, cur.data.length);
			files.set(key, { data: merged, mtime: opts?.mtime ?? cur.mtime });
		},
		async exists(p: string) {
			const key = norm(p);
			return files.has(key) || dirs.has(key);
		},
		async remove(p: string) { files.delete(norm(p)); },
		async rename(from: string, to: string) {
			const key = norm(from);
			const cur = files.get(key);
			if (!cur) throw new Error("ENOENT: " + key);
			addParents(to);
			files.set(norm(to), cur);
			files.delete(key);
		},
		async copy(from: string, to: string) {
			const cur = files.get(norm(from));
			if (!cur) throw new Error("ENOENT: " + from);
			addParents(to);
			files.set(norm(to), { data: cur.data.slice(), mtime: cur.mtime });
		},
		async mkdir(p: string) { addParents(p); dirs.add(norm(p)); },
		async list(p: string) {
			const prefix = norm(p) + "/";
			return {
				files: [...files.keys()].filter((k) => k.startsWith(prefix)),
				folders: [...dirs].filter((k) => k.startsWith(prefix)),
			};
		},
		async read(p: string) {
			const cur = files.get(norm(p));
			return cur ? new TextDecoder().decode(cur.data) : "";
		},
		async readBinary(p: string) {
			const cur = files.get(norm(p));
			if (!cur) throw new Error("ENOENT: " + p);
			return cur.data.buffer.slice(cur.data.byteOffset, cur.data.byteOffset + cur.data.byteLength);
		},
		async stat(p: string) {
			const key = norm(p);
			const cur = files.get(key);
			if (cur) return { type: "file" as const, size: cur.data.length, ctime: 0, mtime: cur.mtime };
			if (dirs.has(key)) return { type: "folder" as const, size: 0, ctime: 0, mtime: 0 };
			return null;
		},
	};

	return { files, dirs, adapter, norm };
}

function makeApp(fs: ReturnType<typeof makeFakeFs>) {
	return {
		vault: {
			configDir: ".obsidian",
			adapter: fs.adapter,
			// Force everything through adapter.stat (the index-miss path), so the
			// in-memory filesystem above is the single source of truth.
			getAbstractFileByPath: (p: string) => (fs.norm(p) === "" ? { children: [] } : null),
		},
	} as any;
}

// Serves CONTENT as three blocks, failing on the block at `failAtBlock`
// (-1 = never fail) to model the connection dying mid-download.
function makeServer(failAtBlock: number) {
	const size = Math.ceil(CONTENT.length / 3);
	const chunks = [CONTENT.slice(0, size), CONTENT.slice(size, size * 2), CONTENT.slice(size * 2)];
	const ids = chunks.map((_, i) => `block${i}`);
	return {
		getFs: async () => [null, { block_ids: ids, size: CONTENT.length, type: 1, version: 1 }],
		getBlock: async (id: string) => {
			const idx = ids.indexOf(id);
			if (idx === failAtBlock) throw new Error("Network request failed (app backgrounded)");
			return new TextEncoder().encode(chunks[idx]).buffer;
		},
	} as any;
}

const settings = { ignore: "", account: "tester" } as any;

describe("interrupted download", () => {
	test("leaves the destination untouched instead of a partial file", async () => {
		const fs = makeFakeFs();
		const app = makeApp(fs);
		initConfig(app, makeServer(1), "seasync");
		const sync = new SyncController(fs.adapter as any, settings);

		await expect(sync.downloadFile(FILE_PATH, remote.id, remote.mtime)).rejects.toThrow();

		// The old code wrote (and pre-stamped) the destination up front, so this
		// is exactly the partial file that used to be left behind.
		expect(await fs.adapter.exists(FILE_PATH)).toBe(false);
	});

	test("a completed download lands with full content and the remote mtime", async () => {
		const fs = makeFakeFs();
		const app = makeApp(fs);
		initConfig(app, makeServer(-1), "seasync");
		const sync = new SyncController(fs.adapter as any, settings);

		await sync.downloadFile(FILE_PATH, remote.id, remote.mtime);

		expect(await fs.adapter.read(FILE_PATH)).toBe(CONTENT);
		const stat = await fs.adapter.stat(FILE_PATH);
		expect(stat!.size).toBe(remote.size);
		expect(Math.floor(stat!.mtime / 1000)).toBe(remote.mtime);
	});

	test("resuming after an interruption re-downloads cleanly, with no conflict copy", async () => {
		const fs = makeFakeFs();
		const app = makeApp(fs);
		initConfig(app, makeServer(1), "seasync");
		const sync = new SyncController(fs.adapter as any, settings);

		// Cycle 1: interrupted part-way.
		await expect(sync.downloadFile(FILE_PATH, remote.id, remote.mtime)).rejects.toThrow();

		// Cycle 2: fresh session -- every node comes back with prevDirty = true
		// and, for a never-completed download, no prev at all.
		initConfig(app, makeServer(-1), "seasync");
		const sync2 = new SyncController(fs.adapter as any, settings);
		// init() normally creates these; pull() appends to the log via setPrevAsync.
		await fs.adapter.write(".obsidian/plugins/seasync/sync_dlog", "");
		await fs.adapter.write(".obsidian/plugins/seasync/sync_data", "");
		await sync2.cleanDownloadTmpDir();
		const root = await SyncNode.deserialize("", { prev: null, children: {} });
		const fileNode = root.createChild(FILE_PATH);
		expect(fileNode.prevDirty).toBe(true);
		expect(fileNode.prev).toBeUndefined();

		const changes: NodeChange[] = [];
		await sync2.pull(changes, "/" + FILE_PATH, fileNode, remote);

		// The whole point: classified as "remote" and re-downloaded, never as a
		// conflict. No conflicts/ directory, and nothing queued for upload.
		const conflictPaths = [...fs.files.keys()].filter((k) => k.startsWith("conflicts/"));
		expect(conflictPaths).toEqual([]);
		expect(changes).toEqual([]);
		expect(fileNode.state.type).toBe("sync");
		expect(await fs.adapter.read(FILE_PATH)).toBe(CONTENT);
	});

	test("no temp files are left in the vault after an interruption", async () => {
		const fs = makeFakeFs();
		const app = makeApp(fs);
		initConfig(app, makeServer(2), "seasync");
		const sync = new SyncController(fs.adapter as any, settings);

		await expect(sync.downloadFile(FILE_PATH, remote.id, remote.mtime)).rejects.toThrow();

		const leftovers = [...fs.files.keys()].filter((k) => k.includes("/tmp/"));
		expect(leftovers).toEqual([]);
	});

	test("cleanDownloadTmpDir sweeps temp files a killed session left behind", async () => {
		const fs = makeFakeFs();
		const app = makeApp(fs);
		initConfig(app, makeServer(-1), "seasync");
		const sync = new SyncController(fs.adapter as any, settings);

		// A process killed outright never runs the catch block, so its temp file
		// survives to the next launch.
		await fs.adapter.write(".obsidian/plugins/seasync/tmp/dl-0", "partial junk");
		await sync.cleanDownloadTmpDir();

		expect(await fs.adapter.exists(".obsidian/plugins/seasync/tmp/dl-0")).toBe(false);
	});

	// pull() fans children out with Promise.all, so a large library has many
	// downloads in flight at once -- which is why backgrounding the app produced
	// hundreds of conflicts rather than one. Each must get its own temp file.
	test("many concurrent downloads don't collide, and all fail clean when interrupted", async () => {
		const paths = Array.from({ length: 200 }, (_, i) => `folder${i % 20}/note${i}.md`);

		const okFs = makeFakeFs();
		const okApp = makeApp(okFs);
		initConfig(okApp, makeServer(-1), "seasync");
		const okSync = new SyncController(okFs.adapter as any, settings);
		await Promise.all(paths.map((p) => okSync.downloadFile(p, remote.id, remote.mtime)));

		// Every file got its own complete content -- no cross-contamination.
		for (const p of paths) expect(await okFs.adapter.read(p)).toBe(CONTENT);
		expect([...okFs.files.keys()].filter((k) => k.includes("/tmp/"))).toEqual([]);

		// Now the same fan-out, interrupted mid-flight the way backgrounding does.
		const badFs = makeFakeFs();
		const badApp = makeApp(badFs);
		initConfig(badApp, makeServer(1), "seasync");
		const badSync = new SyncController(badFs.adapter as any, settings);
		const results = await Promise.allSettled(
			paths.map((p) => badSync.downloadFile(p, remote.id, remote.mtime)));

		expect(results.every((r) => r.status === "rejected")).toBe(true);
		// Not one partial file at a real destination -- previously this was 200.
		for (const p of paths) expect(await badFs.adapter.exists(p)).toBe(false);
		expect([...badFs.files.keys()].filter((k) => k.includes("/tmp/"))).toEqual([]);
	});

	test("an empty remote file still downloads correctly", async () => {
		const fs = makeFakeFs();
		const app = makeApp(fs);
		initConfig(app, makeServer(-1), "seasync");
		const sync = new SyncController(fs.adapter as any, settings);

		await sync.downloadFile(FILE_PATH, ZeroFs, remote.mtime);

		expect(await fs.adapter.exists(FILE_PATH)).toBe(true);
		expect(await fs.adapter.read(FILE_PATH)).toBe("");
	});
});
