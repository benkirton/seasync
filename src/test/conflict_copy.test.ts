import { describe, expect, test } from "bun:test";
import { buildConflictedCopyPath } from "../utils";

describe("buildConflictedCopyPath", () => {
	const when = new Date("2026-07-31T14:35:02.000Z");

	test("keeps directory and extension", () => {
		expect(buildConflictedCopyPath("/notes/todo.md", when))
			.toBe("/notes/todo (conflicted copy 2026-07-31T14-35-02-000Z).md");
	});

	test("handles a path with no directory", () => {
		expect(buildConflictedCopyPath("todo.md", when))
			.toBe("todo (conflicted copy 2026-07-31T14-35-02-000Z).md");
	});

	test("handles a path with no extension", () => {
		expect(buildConflictedCopyPath("notes/README", when))
			.toBe("notes/README (conflicted copy 2026-07-31T14-35-02-000Z)");
	});
});
