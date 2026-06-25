// Optional per-device password persistence for encrypted repos.
//
// Desktop: stores via Electron's safeStorage (OS keychain: macOS Keychain,
// libsecret on Linux, DPAPI on Windows). Only the current OS user can decrypt.
//
// Mobile: falls back to Obsidian's vault-local storage. Not encrypted at rest,
// but on a non-rooted device no other app can read it.
//
// Both backends persist through Obsidian's `app.saveLocalStorage` /
// `app.loadLocalStorage` API. These are device-local and vault-scoped: the
// password is never written to the plugin's `data.json`, so it does not sync
// across devices via Seafile.

import { App, Platform } from "obsidian";

const STORAGE_PREFIX = "seafile-continued-pw:";

type StoredPassword = { kind: "safe" | "plain"; value: string };

export type StoreBackend = "safe-storage" | "local-storage";

// Node Buffer type, sourced from the global without referencing the bare
// `Buffer` identifier (node globals are not available in the browser-only
// lint environment). Buffer.from() returns a Buffer.
type NodeBuffer = ReturnType<typeof window.Buffer.from>;

// Minimal shape of Electron's safeStorage we rely on.
interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): NodeBuffer;
  decryptString(encrypted: NodeBuffer): string;
}

export interface PasswordStore {
  readonly backend: StoreBackend
  readonly description: string
  save: (repoId: string, password: string) => Promise<void>
  load: (repoId: string) => Promise<string | null>
  clear: (repoId: string) => Promise<void>
}

function getSafeStorage (): SafeStorage | null {
	if (Platform.isMobile) return null;
	try {
		const req = (window as unknown as { require?: (module: string) => unknown }).require;
		if (typeof req !== "function") return null;
		const electron = req("electron") as {
			safeStorage?: SafeStorage;
			remote?: { safeStorage?: SafeStorage };
		};
		const safe = electron?.safeStorage ?? electron?.remote?.safeStorage;
		if (safe && typeof safe.isEncryptionAvailable === "function" && safe.isEncryptionAvailable()) {
			return safe;
		}
	} catch {
		// ignore: fall through to vault-local storage
	}
	return null;
}

class SafeStoragePasswordStore implements PasswordStore {
	readonly backend = "safe-storage" as const;
	readonly description = "Encrypted with your OS keychain. Only your device user can decrypt.";

	constructor (private readonly app: App, private readonly safe: SafeStorage) {}

	async save (repoId: string, password: string): Promise<void> {
		const buf = this.safe.encryptString(password);
		const entry: StoredPassword = { kind: "safe", value: buf.toString("base64") };
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, entry);
	}

	async load (repoId: string): Promise<string | null> {
		const entry = this.app.loadLocalStorage(STORAGE_PREFIX + repoId) as StoredPassword | null;
		if (!entry || entry.kind !== "safe") return null;
		try {
			const buf = window.Buffer.from(entry.value, "base64");
			return this.safe.decryptString(buf);
		} catch {
			return null;
		}
	}

	async clear (repoId: string): Promise<void> {
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, null);
	}
}

class LocalStoragePasswordStore implements PasswordStore {
	readonly backend = "local-storage" as const;
	readonly description = "Stored in Obsidian's app-private storage on this device. Less secure than the desktop keychain.";

	constructor (private readonly app: App) {}

	async save (repoId: string, password: string): Promise<void> {
		const entry: StoredPassword = { kind: "plain", value: password };
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, entry);
	}

	async load (repoId: string): Promise<string | null> {
		const entry = this.app.loadLocalStorage(STORAGE_PREFIX + repoId) as StoredPassword | null;
		if (!entry || entry.kind !== "plain") return null;
		return entry.value;
	}

	async clear (repoId: string): Promise<void> {
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, null);
	}
}

let cached: PasswordStore | null = null;
export function getPasswordStore (app: App): PasswordStore {
	if (cached) return cached;
	const safe = getSafeStorage();
	cached = safe ? new SafeStoragePasswordStore(app, safe) : new LocalStoragePasswordStore(app);
	return cached;
}
