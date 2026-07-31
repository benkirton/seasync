// Registers lightweight runtime stubs for packages that have no meaning
// outside a real Obsidian host (or that we don't want to actually retry/throttle
// in tests). Loaded automatically for every `bun test` run via bunfig.toml.
import { mock } from "bun:test";

mock.module("obsidian", () => ({
	Notice: class Notice {
		constructor(_message?: string, _timeout?: number) {}
		hide() {}
	},
	Platform: { isDesktop: true, isMobile: false },
	requestUrl: () => {
		throw new Error("requestUrl is not mocked in unit tests");
	},
	TFile: class TFile {},
	TFolder: class TFolder {},
	arrayBufferToHex: (data: ArrayBuffer) =>
		Array.from(new Uint8Array(data)).map((b) => b.toString(16).padStart(2, "0")).join(""),
}));

mock.module("p-retry", () => ({
	default: async (fn: (attempt: number) => unknown) => await fn(1),
	AbortError: class AbortError extends Error {},
}));

mock.module("p-throttle", () => ({
	default: () => (fn: (...args: unknown[]) => unknown) => fn,
}));

mock.module("p-timeout", () => ({
	default: async (promise: Promise<unknown>) => await promise,
	TimeoutError: class TimeoutError extends Error {},
}));
