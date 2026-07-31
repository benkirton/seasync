// Portable, non-secret repo pointer. Lets a new device/vault pointed at the
// same repo skip re-entering the server URL and browsing for the repo -- it
// still has to log in (and enter the repo passphrase, for encrypted repos),
// since no credentials or tokens are ever written here.
//
// Deliberately not dot-prefixed: Obsidian hides dotfiles from the file
// explorer with no way to reveal them, and many third-party sync tools skip
// dotfiles by default, which made this file effectively unreachable for
// manual copy/inspection.
import type { DataAdapter } from "obsidian";
import type { SeafileSettings } from "./settings";

export const REPO_CONFIG_FILENAME = "seasync.json";

// obsidian://seasync?d=<base64url(JSON)> -- same non-secret fields as the
// exported file, just URI-portable so it can be shared as a link or QR code.
export const URI_ACTION = "seasync";

export interface RepoConfigFile {
  host: string
  repoId: string
  repoName: string
  encrypted: boolean
  encVersion: number
  repoSalt: string
  repoMagic: string
  randomKey: string
}

function isRepoConfigFile(value: unknown): value is RepoConfigFile {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.host === "string" && typeof v.repoId === "string" && typeof v.repoName === "string"
        && typeof v.encrypted === "boolean" && typeof v.encVersion === "number"
        && typeof v.repoSalt === "string" && typeof v.repoMagic === "string" && typeof v.randomKey === "string";
}

function toRepoConfigFile(settings: SeafileSettings): RepoConfigFile {
	return {
		host: settings.host,
		repoId: settings.repoId,
		repoName: settings.repoName,
		encrypted: settings.encrypted,
		encVersion: settings.encVersion,
		repoSalt: settings.repoSalt,
		repoMagic: settings.repoMagic,
		randomKey: settings.randomKey
	};
}

function base64UrlEncode(str: string): string {
	const bytes = new TextEncoder().encode(str);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
	const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

export async function readRepoConfigFile(adapter: DataAdapter): Promise<RepoConfigFile | null> {
	if (!(await adapter.exists(REPO_CONFIG_FILENAME))) return null;
	try {
		const raw: unknown = JSON.parse(await adapter.read(REPO_CONFIG_FILENAME));
		return isRepoConfigFile(raw) ? raw : null;
	} catch {
		return null;
	}
}

export async function writeRepoConfigFile(adapter: DataAdapter, settings: SeafileSettings): Promise<void> {
	await adapter.write(REPO_CONFIG_FILENAME, JSON.stringify(toRepoConfigFile(settings), null, "\t"));
}

export function buildRepoConfigURI(settings: SeafileSettings): string {
	const data = base64UrlEncode(JSON.stringify(toRepoConfigFile(settings)));
	return `obsidian://${URI_ACTION}?d=${data}`;
}

export function parseRepoConfigURI(params: Record<string, string>): RepoConfigFile | null {
	const raw = params.d;
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(base64UrlDecode(raw));
		return isRepoConfigFile(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
