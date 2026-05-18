import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { formatSize } from "./truncate.js";

const DEFAULT_MAX_DEPTH = 6;

const repoStatsSchema = Type.Object({
	path: Type.String({ description: "Repository path or subdirectory path to inspect, relative or absolute" }),
	maxDepth: Type.Optional(
		Type.Number({ description: `Maximum directory traversal depth (default: ${DEFAULT_MAX_DEPTH})` }),
	),
});

export type RepoStatsToolInput = Static<typeof repoStatsSchema>;

export interface RepoStatsToolDetails {
	path: string;
	files: number;
	directories: number;
	totalBytes: number;
	extensions: Record<string, number>;
	maxDepth: number;
}

/**
 * Pluggable filesystem operations for repo_stats.
 *
 * Why this exists: tests and future remote execution environments can provide
 * their own filesystem implementation without changing the tool contract.
 */
export interface RepoStatsOperations {
	realpath: (path: string) => Promise<string>;
	stat: (path: string) => Promise<Stats>;
	readdir: (path: string) => Promise<Dirent[]>;
}

const defaultRepoStatsOperations: RepoStatsOperations = {
	realpath,
	stat,
	readdir: (path) => readdir(path, { withFileTypes: true }),
};

export interface RepoStatsToolOptions {
	operations?: RepoStatsOperations;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function isInsideDirectory(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeExtension(fileName: string): string {
	const extension = extname(fileName).toLowerCase();
	return extension || "[no extension]";
}

function formatRepoStatsSummary(details: RepoStatsToolDetails): string {
	return `Repo stats for ${details.path}: ${details.files} files, ${details.directories} directories, ${formatSize(details.totalBytes)} total.`;
}

function formatRepoStatsCall(
	args: { path?: string; maxDepth?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("repo_stats"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
	if (args?.maxDepth !== undefined) {
		text += theme.fg("toolOutput", ` (max depth ${args.maxDepth})`);
	}
	return text;
}

function formatRepoStatsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: RepoStatsToolDetails;
	},
	_options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	return `\n${theme.fg("toolOutput", output)}`;
}

async function collectRepoStats(
	rootPath: string,
	targetPath: string,
	displayPath: string,
	maxDepth: number,
	ops: RepoStatsOperations,
	signal: AbortSignal | undefined,
): Promise<RepoStatsToolDetails> {
	const details: RepoStatsToolDetails = {
		path: displayPath,
		files: 0,
		directories: 0,
		totalBytes: 0,
		extensions: {},
		maxDepth,
	};

	async function walk(currentPath: string, depth: number): Promise<void> {
		assertNotAborted(signal);
		const entries = await ops.readdir(currentPath);

		for (const entry of entries) {
			assertNotAborted(signal);
			const entryPath = resolvePath(currentPath, entry.name);
			const entryRealPath = await ops.realpath(entryPath);

			// Why this check is repeated: a symlink inside the workspace can point
			// outside it. The tool is read-only, but it should still not inspect
			// files beyond the workspace boundary.
			if (!isInsideDirectory(rootPath, entryRealPath)) {
				continue;
			}

			if (entry.isDirectory()) {
				details.directories += 1;
				if (depth < maxDepth) {
					await walk(entryRealPath, depth + 1);
				}
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const entryStats = await ops.stat(entryRealPath);
			details.files += 1;
			details.totalBytes += entryStats.size;
			const extension = normalizeExtension(entry.name);
			details.extensions[extension] = (details.extensions[extension] ?? 0) + 1;
		}
	}

	const targetStats = await ops.stat(targetPath);
	if (targetStats.isFile()) {
		details.files = 1;
		details.totalBytes = targetStats.size;
		details.extensions[normalizeExtension(targetPath)] = 1;
		return details;
	}

	if (!targetStats.isDirectory()) {
		throw new Error(`Not a file or directory: ${targetPath}`);
	}

	await walk(targetPath, 0);
	return details;
}

export function createRepoStatsToolDefinition(
	cwd: string,
	options?: RepoStatsToolOptions,
): ToolDefinition<typeof repoStatsSchema, RepoStatsToolDetails> {
	const ops = options?.operations ?? defaultRepoStatsOperations;
	return {
		name: "repo_stats",
		label: "repo stats",
		description:
			"Collect read-only repository statistics for a path, including file count, directory count, total size, and extension counts.",
		promptSnippet: "Collect read-only repository statistics",
		promptGuidelines: [
			"Use repo_stats when the user asks for repository size, file counts, directory counts, or extension distribution.",
			"Use read or grep instead when the user asks for specific file contents.",
		],
		parameters: repoStatsSchema,
		async execute(_toolCallId, { path, maxDepth }: RepoStatsToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			assertNotAborted(signal);
			const effectiveMaxDepth = maxDepth ?? DEFAULT_MAX_DEPTH;
			if (!Number.isInteger(effectiveMaxDepth) || effectiveMaxDepth < 0) {
				throw new Error("maxDepth must be a non-negative integer");
			}

			const workspaceRoot = await ops.realpath(cwd);
			const resolvedPath = resolveToCwd(path, cwd);
			const targetPath = await ops.realpath(resolvedPath);

			if (!isInsideDirectory(workspaceRoot, targetPath)) {
				throw new Error(`Path is outside workspace: ${path}`);
			}

			const details = await collectRepoStats(workspaceRoot, targetPath, path, effectiveMaxDepth, ops, signal);
			return {
				content: [{ type: "text", text: formatRepoStatsSummary(details) }],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatRepoStatsCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatRepoStatsResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createRepoStatsTool(cwd: string, options?: RepoStatsToolOptions): AgentTool<typeof repoStatsSchema> {
	return wrapToolDefinition(createRepoStatsToolDefinition(cwd, options));
}
