import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepoStatsTool } from "../src/core/tools/repo-stats.js";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((content) => content.type === "text")
			.map((content) => content.text ?? "")
			.join("\n") ?? ""
	);
}

describe("repo_stats tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `repo-stats-tool-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns read-only repository statistics", async () => {
		mkdirSync(join(testDir, "src"));
		writeFileSync(join(testDir, "package.json"), "{}");
		writeFileSync(join(testDir, "README.md"), "hello");
		writeFileSync(join(testDir, "src", "index.ts"), "export {};\n");

		const tool = createRepoStatsTool(testDir);
		const result = await tool.execute("call-1", { path: "." });

		expect(getTextOutput(result)).toContain("Repo stats for .: 3 files, 1 directories");
		expect(result.details).toEqual({
			path: ".",
			files: 3,
			directories: 1,
			totalBytes: 18,
			extensions: {
				".json": 1,
				".md": 1,
				".ts": 1,
			},
			maxDepth: 6,
		});
	});

	it("honors maxDepth", async () => {
		mkdirSync(join(testDir, "nested"));
		writeFileSync(join(testDir, "top.txt"), "top");
		writeFileSync(join(testDir, "nested", "child.txt"), "child");

		const tool = createRepoStatsTool(testDir);
		const result = await tool.execute("call-2", { path: ".", maxDepth: 0 });

		expect(result.details?.files).toBe(1);
		expect(result.details?.directories).toBe(1);
		expect(result.details?.totalBytes).toBe(3);
		expect(result.details?.extensions).toEqual({ ".txt": 1 });
		expect(result.details?.maxDepth).toBe(0);
	});

	it("rejects paths outside the workspace", async () => {
		const outsideDir = join(tmpdir(), `repo-stats-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(outsideDir, { recursive: true });
		try {
			const tool = createRepoStatsTool(testDir);
			await expect(tool.execute("call-3", { path: outsideDir })).rejects.toThrow(/outside workspace/);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("rejects missing paths", async () => {
		const tool = createRepoStatsTool(testDir);

		await expect(tool.execute("call-4", { path: "missing" })).rejects.toThrow(/ENOENT|not found/i);
	});

	it("honors an already aborted signal", async () => {
		const tool = createRepoStatsTool(testDir);
		const controller = new AbortController();
		controller.abort();

		await expect(tool.execute("call-5", { path: "." }, controller.signal)).rejects.toThrow("Operation aborted");
	});
});
