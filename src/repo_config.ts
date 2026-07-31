// Portable, non-secret repo pointer. Lets a new device/vault pointed at the
// same repo skip re-entering the server URL and browsing for the repo -- it
// still has to log in (and enter the repo passphrase, for encrypted repos),
// since no credentials or tokens are ever written here.
//
// Read/written via the raw DataAdapter (not vault.getAbstractFileByPath /
// fastList), since dotfiles aren't reliably visible through Obsidian's vault
// index (see the "hidden files" limitation in the README) -- this file's
// discovery shouldn't depend on that.
import type { DataAdapter } from "obsidian";
import type { SeafileSettings } from "./settings";

export const REPO_CONFIG_FILENAME = ".seasync";

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
	const config: RepoConfigFile = {
		host: settings.host,
		repoId: settings.repoId,
		repoName: settings.repoName,
		encrypted: settings.encrypted,
		encVersion: settings.encVersion,
		repoSalt: settings.repoSalt,
		repoMagic: settings.repoMagic,
		randomKey: settings.randomKey
	};
	await adapter.write(REPO_CONFIG_FILENAME, JSON.stringify(config, null, "\t"));
}
