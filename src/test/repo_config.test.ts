import { describe, expect, test } from "bun:test";
import { readRepoConfigFile, writeRepoConfigFile, REPO_CONFIG_FILENAME } from "../repo_config";
import type { SeafileSettings } from "../settings";

// Minimal in-memory stand-in for the handful of DataAdapter methods
// repo_config.ts actually uses.
function makeFakeAdapter(initial: Record<string, string> = {}) {
	const files = { ...initial };
	return {
		files,
		exists: async (path: string) => path in files,
		read: async (path: string) => {
			if (!(path in files)) throw new Error(`ENOENT: ${path}`);
			return files[path];
		},
		write: async (path: string, data: string) => { files[path] = data; },
	} as any;
}

function makeSettings(overrides: Partial<SeafileSettings> = {}): SeafileSettings {
	return {
		host: "https://seafile.example.com",
		account: "me@example.com",
		authToken: "secret-auth-token",
		repoName: "My Notes",
		repoId: "repo-123",
		repoToken: "secret-repo-token",
		deviceName: "SeaSync",
		deviceId: "device-abc",
		interval: 30000,
		ignore: "",
		devMode: false,
		enableSync: true,
		useFetch: false,
		encrypted: true,
		encVersion: 4,
		repoSalt: "deadbeef",
		repoMagic: "magic-value",
		randomKey: "random-key-value",
		...overrides,
	};
}

describe("repo_config", () => {
	test("returns null when the file doesn't exist", async () => {
		const adapter = makeFakeAdapter();
		expect(await readRepoConfigFile(adapter)).toBeNull();
	});

	test("write then read round-trips the non-secret fields", async () => {
		const adapter = makeFakeAdapter();
		const settings = makeSettings();

		await writeRepoConfigFile(adapter, settings);
		const config = await readRepoConfigFile(adapter);

		expect(config).toEqual({
			host: settings.host,
			repoId: settings.repoId,
			repoName: settings.repoName,
			encrypted: settings.encrypted,
			encVersion: settings.encVersion,
			repoSalt: settings.repoSalt,
			repoMagic: settings.repoMagic,
			randomKey: settings.randomKey,
		});
	});

	test("never writes credentials or tokens", async () => {
		const adapter = makeFakeAdapter();
		await writeRepoConfigFile(adapter, makeSettings());

		const raw = adapter.files[REPO_CONFIG_FILENAME];
		expect(raw).not.toContain("secret-auth-token");
		expect(raw).not.toContain("secret-repo-token");
		expect(raw).not.toContain("me@example.com");
	});

	test("returns null for invalid JSON instead of throwing", async () => {
		const adapter = makeFakeAdapter({ [REPO_CONFIG_FILENAME]: "not json" });
		expect(await readRepoConfigFile(adapter)).toBeNull();
	});

	test("returns null for JSON that doesn't match the expected shape", async () => {
		const adapter = makeFakeAdapter({ [REPO_CONFIG_FILENAME]: JSON.stringify({ host: "https://x" }) });
		expect(await readRepoConfigFile(adapter)).toBeNull();
	});
});
