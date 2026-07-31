import * as IgnoreParser from "gitignore-parser";
import { posix as Path } from "path-browserify";
import { Notice, Platform, type DataAdapter } from "obsidian";
import { type SeafileSettings } from "src/settings";
import { DEFAULT_IGNORE, HEAD_COMMIT_PATH, SYNC_DATA_PATH, SYNC_DLOG_PATH, server } from "../config";
import { AuthError, MODE_DIR, MODE_FILE, ZeroFs, type DirSeafDirent, type DirSeafFs, type FileSeafDirent, type FileSeafFs, type SeafDirent, type SeafFs } from "../server";
import * as utils from "../utils";
import { debug } from "../utils";
import { SyncNode, type STATE_UPLOAD, type SyncStateChangedListener as NodeStateChangedListener } from "./node";
import { MobileDataAdapter } from "src/@types/obsidian";

export interface NodeChange {
  node: SyncNode
  type: "add" | "remove-file" | "remove-folder" | "modify"
}

export interface SYNC_IDLE {
  type: "idle"
}

export interface SYNC_BUSY {
  type: "busy"
  toStop?: boolean
  message?: "download" | "upload" | "fetch"
}

export interface SYNC_STOP {
  type: "stop"
  message?: "error" | "user" | "auth"
}

export type SyncStatus = SYNC_IDLE | SYNC_BUSY | SYNC_STOP

export class SyncController {
	private ignore: {
    accepts: (input: string) => boolean
    denies: (input: string) => boolean
    maybe: (input: string) => boolean
  };

	private nodeRoot: SyncNode;

	public constructor (
    private readonly adapter: DataAdapter,
    private readonly settings: SeafileSettings) {
		this.setIgnorePattern(settings.ignore);
	}

	public setIgnorePattern (pattern: string) {
		this.ignore = IgnoreParser.compile(DEFAULT_IGNORE + "\n" + pattern);
	}

	// True if this vault has synced before (has real sync_data/sync_dlog
	// content on disk). Must be called before init(), which creates those
	// files as empty placeholders if they don't exist yet. Used to gate the
	// "first sync against an already-populated repo" warning.
	public async hasExistingLocalState (): Promise<boolean> {
		for (const path of [SYNC_DATA_PATH, SYNC_DLOG_PATH]) {
			if (await this.adapter.exists(path)) {
				const data = await this.adapter.read(path);
				if (data.trim().length > 0) return true;
			}
		}
		return false;
	}

	// Load sync data
	async init () {
		SyncNode.onStateChanged = n => { this.raiseNodeStateChanged(n); };
		this.nodeRoot = await SyncNode.load();

		// Obsidian's adapter.append() throws ENOENT if the file doesn't exist,
		// so ensure the log/data files are present before sync writes to them.
		for (const path of [SYNC_DLOG_PATH, SYNC_DATA_PATH]) {
			if (!await this.adapter.exists(path)) {
				await this.adapter.write(path, "");
			}
		}

		if (this.localHead === undefined) {
			if (await this.adapter.exists(HEAD_COMMIT_PATH)) {
				this.localHead = await this.adapter.read(HEAD_COMMIT_PATH);
			} else {
				this.localHead = "";
			}
		}
	}

	async downloadFile (path: string, fsId: string, mtime: number) {
		this.ignoreChange.add(path);
		try {
			mtime = mtime * 1000;
			await this.adapter.write(path, "", { mtime });

			if (fsId == ZeroFs) {
				return;
			}

			let nativePath;
			if (Platform.isMobile) {
				nativePath = (this.adapter as MobileDataAdapter).getNativePath(path);
			}

			const [, fs] = await server.getFs(fsId);
			for (const blockId of (fs as FileSeafFs).block_ids) {
				const block = await server.getBlock(blockId);
				if (Platform.isDesktop) {
					await this.adapter.append(path, new DataView(block) as unknown as string, { mtime });
				} else {
					// Hacky way to get the filesystem plugin to append to file when mobile
					const encoded = await utils.arrayBufferToBase64(block);
					const capacitor = window.top as unknown as {
						Capacitor: { Plugins: { Filesystem: { appendFile(options: { path: string; data: string }): Promise<void> } } }
					};
					// nativePath is intentionally passed through unchanged to preserve
					// existing runtime behavior (it is not awaited here).
					await capacitor.Capacitor.Plugins.Filesystem.appendFile({ path: nativePath as unknown as string, data: encoded });
				}
			}

			if (Platform.isMobile) {
				await this.adapter.append(path, "", { mtime }); // Set mtime
			}
		} finally {
			this.ignoreChange.delete(path);
		}
	}

	public onNodeStateChanged?: NodeStateChangedListener;
	private raiseNodeStateChanged (node: SyncNode) {
		this.onNodeStateChanged?.(node);
	}

	// True if the local file's content hashes to the same fs id Seafile already
	// has for `remote` -- i.e. genuinely the same bytes, just with a different
	// local mtime (the common case when first linking a device to an already-
	// populated repo). Reuses the same chunk/hash algorithm as a real upload,
	// so this is authoritative, not a heuristic.
	private async contentMatches (path: string, remote: FileSeafDirent): Promise<boolean> {
		try {
			const [dirent] = await this.computeFileDirent(path, this.settings.account);
			return dirent.id === remote.id;
		} catch {
			return false;
		}
	}

	// One conflicts/<timestamp>/ folder per sync cycle, so multiple conflicts
	// found in the same cycle land together instead of each getting its own
	// timestamp. Reset in sync().
	private conflictBatchStamp: string | null = null;
	private getConflictBatchStamp (): string {
		if (!this.conflictBatchStamp) this.conflictBatchStamp = utils.conflictBatchStamp();
		return this.conflictBatchStamp;
	}

	private async ensureLocalDir (dir: string): Promise<void> {
		if (!dir) return;
		let cur = "";
		for (const part of dir.split("/").filter(Boolean)) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.adapter.exists(cur))) {
				try { await this.adapter.mkdir(cur); } catch { /* created concurrently, ignore */ }
			}
		}
	}

	// Preserve the local side of a conflict before it gets overwritten by the
	// remote download. The copy is a brand new, untracked local file under
	// conflicts/, so the normal fastList-based scan picks it up as a plain
	// local addition on the next sync cycle and uploads it like anything else.
	private async saveLocalConflictCopy (path: string): Promise<void> {
		const conflictPath = utils.buildConflictPath(path, this.getConflictBatchStamp());
		await this.ensureLocalDir(Path.dirname(conflictPath));
		await this.adapter.copy(path, conflictPath);
	}

	// Preserve the remote side of a conflict before it gets overwritten by the
	// local upload. Fetches the full file in one shot rather than the desktop/
	// mobile append dance in downloadFile() -- conflicts are rare, so simplicity
	// wins over streaming here.
	private async saveRemoteConflictCopy (path: string, remote: FileSeafDirent): Promise<void> {
		const conflictPath = utils.buildConflictPath(path, this.getConflictBatchStamp());
		await this.ensureLocalDir(Path.dirname(conflictPath));
		if (remote.id === ZeroFs) {
			await this.adapter.write(conflictPath, "", { mtime: remote.mtime * 1000 });
			return;
		}

		const [, fs] = await server.getFs(remote.id);
		let bytes = new Uint8Array();
		for (const blockId of (fs as FileSeafFs).block_ids) {
			const block = await server.getBlock(blockId);
			bytes = utils.concatTypedArrays(bytes, new Uint8Array(block));
		}
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		await this.adapter.writeBinary(conflictPath, buffer, { mtime: remote.mtime * 1000 });
	}

	public async pull (changes: NodeChange[], path: string, node: SyncNode, remote?: SeafDirent) {
		// Step 0. Check ignore pattern
		if (this.ignore.denies(path)) {
			if (remote) {
				await node.setPrevAsync(remote, false);
				node.state = { type: "sync" };
				return;
			} else {
				await node.delete();
				return;
			}
		}

		// Step 1. Check file status: same, local, remote, merge, conflict
		const local = await utils.fastStat(path);

		let target = null;
		// Same:
		// - both are null
		// - prev not dirty, prev id == remote id
		// - mtime is same, type is file, size is same
		if (
			(!local && !remote) ||
            (node?.prev && remote && !node.prevDirty && node.prev.id === remote.id) ||
            (local && remote && Math.floor(local.mtime / 1000) === remote.mtime && local.type == "file" && remote.mode == MODE_FILE && local.size === remote.size)
		) {
			target = "same";
			if (local || remote) {
				await node.setPrevAsync(remote, false);
				node.state = { type: "sync" };
			} else {
				await node.delete();
			}
			return;
		}
		// Local:
		// prev and remote is null
		// prev and remote have same id
		else if (
			(!remote && !node.prev) ||
            (node.prev && remote && node.prev.id === remote.id)
		) {
			target = "local";
		}

		// Remote: Local matches prev
		// prev is not dirty
		// prev and local is null
		// prev and local are files, prev mtime and size matches local
		else if (
			(!node.prevDirty) ||
            (!local && !node.prev) ||
            (node.prev?.mode == MODE_FILE && local?.type == "file" && node.prev.mtime === Math.floor(local.mtime / 1000) && node.prev.size === local.size)
		) {
			target = "remote";
		}

		// Merge:
		// Neither is a file
		else if (local?.type !== "file" && remote?.mode !== MODE_FILE) {
			target = "merge";
		}
		// Last chance before declaring a real conflict: no shared history (e.g.
		// first-ever sync against an already-populated remote from another
		// device), but the content is actually identical -- just hashed
		// differently-timestamped local file against remote. Cheap size check
		// first; only hash on a size match, since a real conflict almost always
		// differs in size anyway.
		else if (
			local?.type === "file" && remote?.mode === MODE_FILE &&
	        local.size === remote.size && await this.contentMatches(path, remote)
		) {
			await node.setPrevAsync(remote, false);
			node.state = { type: "sync" };
			return;
		}
		// Conflict:
		// One is a file
		else {
			target = "conflict";
		}

		// Step 2. Resolve conflicts
		if (target == "conflict") {
			// Only one side exists
			if (local && !remote) target = "local";
			else if (!local && remote) target = "remote";
			else {
				// Both sides changed since the last sync. Take the newer one, but
				// don't just discard the loser -- keep it as a "conflicted copy" so
				// a concurrent edit on two devices doesn't silently lose one side.
				const localNewer = Math.floor(local!.mtime / 1000) > remote!.mtime;
				target = localNewer ? "local" : "remote";

				const bothFiles = local!.type === "file" && remote!.mode === MODE_FILE;
				if (bothFiles) {
					if (localNewer) {
						await this.saveRemoteConflictCopy(path, remote as FileSeafDirent);
					} else {
						await this.saveLocalConflictCopy(path);
					}
					new Notice(`Seafile: conflicting edits at "${path}". Kept the newer version and saved the other as a conflicted copy.`);
				} else {
					// A file/folder type mismatch (e.g. one device deleted a folder and
					// created a same-named file). Rarer, and recursively snapshotting a
					// whole folder tree isn't implemented -- at least warn instead of
					// silently dropping it.
					const discardedSide = localNewer ? "remote" : "local";
					const discardedKind = localNewer ? (remote!.mode == MODE_FILE ? "file" : "folder") : local!.type;
					new Notice(`Seafile: conflict at "${path}" (${discardedSide} ${discardedKind} vs. the other side's different type). Kept the newer item; the ${discardedSide} ${discardedKind} could not be preserved and was discarded.`);
				}

				if (target == "remote") {
					if (local!.type == "file") { await this.adapter.remove(path); } else { await this.adapter.rmdir(path, true); }
				}
			}
		}

		// Step 3. Update and merge
		// 3.1 Branching
		let newChildrenNames: Set<string> | null = null;
		const newRemote: Record<string, SeafDirent> = {};

		if ((target == "local" || target == "merge") && local && local.type == "folder") {
			const list = await utils.fastList(path);
			if (!newChildrenNames) newChildrenNames = new Set();
			for (const name of list) {
				newChildrenNames.add(name);
			}
		}
		if ((target == "remote" || target == "merge") && remote && remote.mode == MODE_DIR) {
			const [, rawFs] = await server.getFs(remote.id);
			const fs = rawFs as DirSeafFs | null;
			if (!newChildrenNames) newChildrenNames = new Set();
			if (fs) {
				for (const dirent of fs.dirents) {
					newRemote[dirent.name] = dirent;
					newChildrenNames.add(dirent.name);
				}
			}
		}

		const nodeChildren = node.getChildren();

		// null means no need to pull children
		if (newChildrenNames) {
			for (const name in nodeChildren) {
				newChildrenNames.add(name);
			}

			if (target == "remote" && !local) {
				await this.adapter.mkdir(path);
			}

			const promises = [];
			for (const name of newChildrenNames) {
				const nodeChild = nodeChildren[name] ?? node.createChild(name);
				const remoteChild = target == "local" ? nodeChild.prev : newRemote[name];

				promises.push(
					this.pull(
						changes,
						path + "/" + name,
						nodeChild,
						remoteChild
					));
			}
			await Promise.all(promises);

			// After pulling children, merge status is changed to local
			if (target == "merge") {
				if (Object.keys(nodeChildren).length === 0) {
					// Merge result is an empty folder
					if (!remote) {
						await this.adapter.rmdir(path, true);
						await node.delete();
						changes.push({ node, type: "remove-folder" });
						return;
					} else {
						// Local not exist
						await this.adapter.mkdir(path);
						await node.setPrevAsync(remote, false);
						node.state = { type: "sync" };
						return;
					}
				} else {
					// Merge result is a non-empty folder, use local to compute new fs and dirent
					target = "local";
				}
			}
		}

		// 3.2 Updating
		if (target == "remote") {
			if (!remote) {
				if (local) {
					if (local.type == "file") {
						await this.adapter.remove(path);
					} else {
						await this.adapter.rmdir(path, true);
					}
				}
				await node.delete();
				return;
			} else {
				if (remote.mode == MODE_FILE) {
					node.state = { type: "download", param: 0 };
					await this.downloadFile(path, remote.id, remote.mtime);
					await node.setPrevAsync(remote, false);
					node.state = { type: "sync" };
					return;
				} else {
					await node.setPrevAsync(remote, true);
					// Let below code to recompute dirent and fs
				}
			}
		}

		if (target == "local") {
			if (!local) {
				if (remote!.mode == MODE_FILE) {
					changes.push({ node, type: "remove-file" });
				} else {
					changes.push({ node, type: "remove-folder" });
				}
				await node.delete();
				return;
			} else if (local.type === "file") {
				const [dirent, fs, blocks] = await this.computeFileDirent(path, this.settings.account);
				node.setNext(dirent, false);
				node.state = { type: "upload", param: { progress: 0, fs, blocks } };
				changes.push({ node, type: remote ? "modify" : "add" });
				return;
			}
		}

		// Recomputing dirent and fs base on current local folder
		const mtime = (remote?.mtime) ?? (node?.prev?.mtime);
		const dirents: SeafDirent[] = [];
		for (const child of Object.values(nodeChildren)) {
			if (child.next) dirents.push(child.next);
			else if (child.prev) dirents.push(child.prev);
			else throw new Error("Cannot find next or prev of child");
		}

		const [dirent, fs] = await this.computeDirDirent(path, dirents, mtime);
		if (dirent.id === remote?.id) {
			await node.setPrevAsync(dirent, false);
			node.state = { type: "sync" };
		} else {
			node.setNext(dirent, false);
			node.state = { type: "upload", param: { progress: 0, fs } };
			changes.push({ node, type: remote ? "modify" : "add" });
			debug.log(`Upload "${path}"`);
			debug.log([dirent.id, fs], remote ? await server.getFs(remote.id) : null);
		}
	}

	async computeFileDirent (path: string, modifier: string): Promise<[FileSeafDirent, SeafFs | null, Record<string, ArrayBuffer>]> {
		const stat = await utils.fastStat(path);
		if (!stat) throw new Error("Cannot compute fs of non-existent file");

		let blockBuffer: Record<string, ArrayBuffer> = {};
		let fsId: string, fs: SeafFs | null;

		if (stat.size == 0) {
			[fsId, fs] = [ZeroFs, null];
		} else {
			// to do: warn if file too large
			const buffer = await this.adapter.readBinary(path);
			blockBuffer = server.crypto
				? await utils.computeBlocksEncrypted(buffer, (chunk) => server.crypto!.encryptBlock(chunk))
				: await utils.computeBlocks(buffer);

			fs = {
				block_ids: Object.keys(blockBuffer),
				size: stat.size,
				type: 1,
				version: 1
			};
			fsId = await utils.computeFsId(fs);
		}

		const dirent: FileSeafDirent = {
			id: fsId,
			mode: MODE_FILE,
			modifier,
			mtime: Math.floor(stat.mtime / 1000),
			name: Path.basename(path),
			size: stat.size
		};

		return [dirent, fs, blockBuffer];
	}

	async createDirFs (children: SeafDirent[]): Promise<[string, SeafFs | null]> {
		if (children.length === 0) { return [ZeroFs, null]; }

		// Copy before sorting: `children` is owned by the caller.
		const childrenDirents: SeafDirent[] = [...children];

		childrenDirents.sort((a: SeafDirent, b: SeafDirent) => {
			return utils.strcmp(b.name, a.name);
		});

		const fs: DirSeafFs = {
			dirents: childrenDirents,
			type: 3,
			version: 1
		};
		const fsId = await utils.computeFsId(fs);
		return [fsId, fs];
	}

	async computeDirDirent (path: string, children: SeafDirent[], defaultMtime?: number): Promise<[DirSeafDirent, SeafFs | null]> {
		const name = Path.basename(path);

		const [fsId, fs] = await this.createDirFs(children);

		let mtime = defaultMtime;
		if (!mtime) {
			mtime = -1;
			for (const child of children) {
				if (child.mtime > mtime) { mtime = child.mtime; }
			}
			if (mtime === -1) {
				mtime = (defaultMtime) ?? Math.floor(new Date().getTime() / 1000);
			}
		}

		const dirent: DirSeafDirent = {
			id: fsId,
			mode: MODE_DIR,
			mtime,
			name
		};

		return [dirent, fs];
	}

	async computeBlocks (localPath: string): Promise<Record<string, ArrayBuffer>> {
		const stat = await utils.fastStat(localPath);
		if (!stat) throw new Error(`File '${localPath}' does not exist.`);
		if (stat.type != "file") throw new Error(`Path '${localPath}' is not a file.`);

		if (stat.size === 0) {
			return {};
		}

		// if size > 50MB, warn user
		if (stat.size > 50 * 1024 * 1024) {
			debug.warn(`File '${localPath}' is larger than 50MB. This may take a while or even crash obsidian.`);
		}

		const blocks: Record<string, ArrayBuffer> = {};
		const buffer = await this.adapter.readBinary(localPath);
		const blockSize = 8 * 1024 * 1024; // 8MB
		const numBlocks = Math.ceil(stat.size / blockSize);
		for (let i = 0; i < numBlocks; i++) {
			const blockStart = i * blockSize;
			const blockEnd = blockStart + blockSize;
			const block = buffer.slice(blockStart, blockEnd);
			const hash = await utils.sha1(block); // Ensure utils.sha1 can handle ArrayBuffer or adjust accordingly
			blocks[hash] = block;
		}

		return blocks;
	}

	async push (nodeRoot: SyncNode, changes: NodeChange[], parentCommitId: string): Promise<string> {
		if (!nodeRoot.next) {
			debug.log("Nothing to push");
			return parentCommitId;
		}

		const uploads = changes.filter(change => change.type == "add" || change.type == "modify").map(change => change.node);
		// Upload fs
		await Promise.all(uploads.map(async (node) => {
			if (node.state.type !== "upload" || !node.next) {
				throw Error("Node is not in upload state or has no next");
			}

			const uploadState: STATE_UPLOAD = node.state;
			const param = uploadState.param;
			if (param.blocks) {
				const blocks: Record<string, ArrayBuffer> = param.blocks;
				await Promise.all(Object.entries(blocks).map(async ([blockId, block]: [string, ArrayBuffer]) => {
					if (await server.checkBlock(blockId)) { await server.sendBlock(blockId, block); }
				}));
			}
			if (param.fs && await server.checkFs(node.next.id)) { await server.sendFs([node.next.id, param.fs]); }
		}));

		// Create commit
		const description = server.describeCommit({
			addedFiles: changes.filter(c => c.type == "add" && c.node.next!.mode == MODE_FILE).map(c => c.node.name),
			removedFiles: changes.filter(c => c.type == "remove-file").map(c => c.node.name),
			modifiedFiles: changes.filter(c => c.type == "modify" && c.node.next!.mode == MODE_FILE).map(c => c.node.name),
			addedDirectories: changes.filter(c => c.type == "add" && c.node.next!.mode == MODE_DIR).map(c => c.node.name),
			removedDirectories: changes.filter(c => c.type == "remove-folder").map(c => c.node.name),
			renamedFiles: [],
			renamedDirectories: []
		});
		const commit = await server.createCommit(nodeRoot.next.id, description, parentCommitId);
		await server.uploadCommit(commit);
		await server.setHeadCommit(commit.commit_id);

		// Update nodes
		for (const node of uploads) {
			await node.applyNext();
		}

		return commit.commit_id;
	}

	private readonly ignoreChange = new Set<string>();
	async notifyChange (path: string, type: "create" | "modify" | "delete") {
		if (this.ignoreChange.has(path)) return;

		if (type == "create") {
			if (this.nodeRoot.find(path)) return;
		}
		if (type == "delete") {
			if (!this.nodeRoot.find(path)) return;
		}
		if (type == "modify") {
			const node = this.nodeRoot.find(path);
			if (node?.prev) {
				const local = await utils.fastStat(path);
				if (local && Math.floor(local.mtime / 1000) === node.prev.mtime) return;
			}
		}

		this.nodeRoot.setDirty(path);
	}

	private localHead: string;
	private async setLocalHeadAsync (commitId: string) {
		if (this.localHead != commitId) {
			this.localHead = commitId;
			await this.adapter.write(HEAD_COMMIT_PATH, this.localHead);
		}
	}

	async sync () {
		this.status = { type: "busy", message: "fetch" };
		this.conflictBatchStamp = null;
		const changes: NodeChange[] = [];
		const remoteHead = await server.getHeadCommitId();
		const remoteRoot = await server.getCommitRoot(remoteHead);

		this.status.message = "download";
		await this.pull(changes, "", this.nodeRoot, remoteRoot);
		await this.setLocalHeadAsync(remoteHead);

		this.status.message = "upload";
		const newHead = await this.push(this.nodeRoot, changes, this.localHead);
		await this.setLocalHeadAsync(newHead);

		if (SyncNode.dataLogCount > 100) { await SyncNode.save(this.nodeRoot); }
	}

	private timeoutId: number;

	// Consecutive sync() failures. A single transient error (dropped connection,
	// server hiccup) should not require the user to notice a Notice and manually
	// click "resume" -- retry with backoff instead, and only give up for real
	// after several failures in a row.
	private consecutiveFailures = 0;
	private static readonly MAX_CONSECUTIVE_FAILURES = 5;
	private static readonly MAX_BACKOFF_MS = 5 * 60 * 1000;

	private _status: SyncStatus = { type: "stop" };
	public get status () { return this._status; }
	private set status (value) {
		this._status = new Proxy<SyncStatus>(value, {
			set: (target, prop, value) => {
				Reflect.set(target, prop, value);
				this.onSyncStatusChanged?.(target);
				return true;
			}
		});
		this.onSyncStatusChanged?.(value);
	}

	public onSyncStatusChanged: ((status: SyncStatus) => void) | null = null;

	// Fired when a sync attempt is stopped specifically because the server
	// rejected the auth/repo token (401/403), as opposed to a generic/transient
	// failure. Separate from onSyncStatusChanged (owned by the explorer UI) so
	// main.ts can prompt the user to log in again without clobbering it.
	public onAuthFailure: (() => void) | null = null;

	startSync () {
		if (this.status.type == "stop") {
			debug.log("Sync started");
			this.consecutiveFailures = 0;
			this.status = { type: "idle" };
			void this.syncCycle();
		} else if (this.status.type == "busy" && this.status.toStop) {
			this.status.toStop = false;
		} else if (this.status.type == "idle") {
			debug.log("Sync started");
			window.clearTimeout(this.timeoutId);
			void this.syncCycle();
		}
	}

	async syncCycle () {
		if (this.status.type == "idle") {
			this.status = { type: "busy" };

			debug.time("Sync");
			let failed = false;
			try {
				await this.sync();
				this.consecutiveFailures = 0;
			} catch (e) {
				failed = true;
				debug.error(e);

				if (e instanceof AuthError) {
					// Retrying with the same rejected token won't help -- stop now
					// instead of burning through the backoff budget, and let main.ts
					// prompt the user to log in again.
					this.status = { type: "stop", message: "auth" };
					this.onAuthFailure?.();
				} else {
					this.consecutiveFailures++;

					if (this.consecutiveFailures >= SyncController.MAX_CONSECUTIVE_FAILURES) {
						this.status = { type: "stop", message: "error" };
						new Notice(`Sync failed after ${this.consecutiveFailures} attempts: ${(e as Error).message}`);
					} else {
						debug.warn(`Sync attempt ${this.consecutiveFailures} failed, retrying: ${(e as Error).message}`);
					}
				}
			} finally {
				debug.timeEnd("Sync");
			}

			if (this.status.type === "busy") {
				if (this.status.toStop) {
					this.status = { type: "stop" };
					debug.log("Sync stopped");
				} else {
					this.status = { type: "idle" };
					const delay = failed
						? Math.min(this.settings.interval * (2 ** (this.consecutiveFailures - 1)), SyncController.MAX_BACKOFF_MS)
						: this.settings.interval;
					this.timeoutId = window.setTimeout(() => {
						void this.syncCycle();
					}, delay);
				}
			}
		}
	}

	async stopSyncAsync (): Promise<void> {
		if (this.status.type == "idle") {
			window.clearTimeout(this.timeoutId);
			this.status = { type: "stop" };
			debug.log("Sync stopped");
			await Promise.resolve();
		} else if (this.status.type == "busy") {
			this.status.toStop = true;
			debug.log("Sync stopping");
			await new Promise<void>(resolve => {
				const oldListener = this.onSyncStatusChanged;
				this.onSyncStatusChanged = (status) => {
					if (status.type == "stop") {
						this.onSyncStatusChanged = oldListener;
						resolve();
					}

					oldListener?.(status);
				};
			});
		} else {
			await Promise.resolve();
		}
	}
}
