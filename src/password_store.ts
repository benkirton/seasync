// Optional per-device password persistence for encrypted repos.
//
// Desktop: stores via Electron's safeStorage (OS keychain: macOS Keychain,
// libsecret on Linux, DPAPI on Windows). Only the current OS user can decrypt.
//
// Mobile: falls back to localStorage in Obsidian's app-private storage. Not
// encrypted at rest, but on a non-rooted device no other app can read it.

import { Platform } from "obsidian";

const STORAGE_PREFIX = "seafile-continued-pw:";
const META_PREFIX = "seafile-continued-pw-meta:";

export type StoreBackend = "safe-storage" | "local-storage";

export interface PasswordStore {
  readonly backend: StoreBackend
  readonly description: string
  save: (repoId: string, password: string) => Promise<void>
  load: (repoId: string) => Promise<string | null>
  clear: (repoId: string) => Promise<void>
}

function getSafeStorage (): any | null {
	if (Platform.isMobile) return null;
	try {
		const req = (window as any).require;
		if (typeof req !== "function") return null;
		const electron = req("electron");
		const safe = electron?.safeStorage ?? electron?.remote?.safeStorage;
		if (safe && typeof safe.isEncryptionAvailable === "function" && safe.isEncryptionAvailable()) {
			return safe;
		}
	} catch {
		// ignore — fall through to localStorage
	}
	return null;
}

class SafeStoragePasswordStore implements PasswordStore {
	readonly backend = "safe-storage" as const;
	readonly description = "Encrypted with your OS keychain. Only your device user can decrypt.";

	constructor (private readonly safe: any) {}

	async save (repoId: string, password: string): Promise<void> {
		const buf: Buffer = this.safe.encryptString(password);
		localStorage.setItem(STORAGE_PREFIX + repoId, buf.toString("base64"));
		localStorage.setItem(META_PREFIX + repoId, "safe");
	}

	async load (repoId: string): Promise<string | null> {
		const meta = localStorage.getItem(META_PREFIX + repoId);
		const b64 = localStorage.getItem(STORAGE_PREFIX + repoId);
		if (!b64 || meta !== "safe") return null;
		try {
			const buf = Buffer.from(b64, "base64");
			return this.safe.decryptString(buf);
		} catch {
			return null;
		}
	}

	async clear (repoId: string): Promise<void> {
		localStorage.removeItem(STORAGE_PREFIX + repoId);
		localStorage.removeItem(META_PREFIX + repoId);
	}
}

class LocalStoragePasswordStore implements PasswordStore {
	readonly backend = "local-storage" as const;
	readonly description = "Stored in Obsidian's app-private storage on this device. Less secure than the desktop keychain.";

	async save (repoId: string, password: string): Promise<void> {
		localStorage.setItem(STORAGE_PREFIX + repoId, password);
		localStorage.setItem(META_PREFIX + repoId, "plain");
	}

	async load (repoId: string): Promise<string | null> {
		const meta = localStorage.getItem(META_PREFIX + repoId);
		if (meta !== "plain") return null;
		return localStorage.getItem(STORAGE_PREFIX + repoId);
	}

	async clear (repoId: string): Promise<void> {
		localStorage.removeItem(STORAGE_PREFIX + repoId);
		localStorage.removeItem(META_PREFIX + repoId);
	}
}

let cached: PasswordStore | null = null;
export function getPasswordStore (): PasswordStore {
	if (cached) return cached;
	const safe = getSafeStorage();
	cached = safe ? new SafeStoragePasswordStore(safe) : new LocalStoragePasswordStore();
	return cached;
}
