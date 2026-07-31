import { describe, expect, test } from "bun:test";
import { buildConflictPath, conflictBatchStamp } from "../utils";

describe("conflictBatchStamp", () => {
	test("is filesystem-safe (no colons or dots)", () => {
		const stamp = conflictBatchStamp(new Date("2026-07-31T14:35:02.000Z"));
		expect(stamp).toBe("2026-07-31T14-35-02-000Z");
	});
});

describe("buildConflictPath", () => {
	const stamp = "2026-07-31T14-35-02-000Z";

	test("nests the original relative path under conflicts/<stamp>/", () => {
		expect(buildConflictPath("/notes/todo.md", stamp))
			.toBe("conflicts/2026-07-31T14-35-02-000Z/notes/todo.md");
	});

	test("handles a path with no leading slash", () => {
		expect(buildConflictPath("todo.md", stamp))
			.toBe("conflicts/2026-07-31T14-35-02-000Z/todo.md");
	});

	test("handles a nested path with no extension", () => {
		expect(buildConflictPath("notes/README", stamp))
			.toBe("conflicts/2026-07-31T14-35-02-000Z/notes/README");
	});
});
