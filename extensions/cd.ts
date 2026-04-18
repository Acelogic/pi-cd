import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function resolveTarget(input: string, baseCwd: string, previousDir: string | null): string | null {
	const trimmed = input.trim();
	if (!trimmed) return os.homedir();
	if (trimmed === "-") return previousDir;
	const expanded = expandHome(trimmed);
	const abs = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);
	try {
		return fs.realpathSync.native(abs);
	} catch {
		return abs;
	}
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

type Completion = { value: string; label: string };

function completeDirs(prefix: string, baseCwd: string): Completion[] {
	const trimmed = prefix ?? "";
	let searchDir: string;
	let partial: string;

	if (trimmed.endsWith("/")) {
		searchDir = expandHome(trimmed);
		partial = "";
	} else {
		const lastSlash = trimmed.lastIndexOf("/");
		if (lastSlash === -1) {
			searchDir = baseCwd;
			partial = trimmed;
		} else {
			searchDir = expandHome(trimmed.slice(0, lastSlash + 1));
			partial = trimmed.slice(lastSlash + 1);
		}
	}

	const resolvedSearch = path.isAbsolute(searchDir)
		? searchDir
		: path.resolve(baseCwd, searchDir);

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(resolvedSearch, { withFileTypes: true });
	} catch {
		return [];
	}

	const items: Completion[] = [];
	const lowerPartial = partial.toLowerCase();
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (partial && !entry.name.toLowerCase().startsWith(lowerPartial)) continue;
		if (entry.name.startsWith(".") && !partial.startsWith(".")) continue;
		const displayPrefix = trimmed.endsWith("/")
			? trimmed
			: trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
		const value = `${displayPrefix}${entry.name}/`;
		items.push({ value, label: value });
	}
	items.sort((a, b) => a.value.localeCompare(b.value));
	return items.slice(0, 50);
}

export default function cdExtension(pi: ExtensionAPI) {
	let previousDir: string | null = null;

	pi.registerCommand("cd", {
		description: "Switch the session's working directory (forks into target cwd)",
		getArgumentCompletions: (prefix) => {
			const items = completeDirs(prefix, process.cwd());
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const target = resolveTarget(args, ctx.cwd, previousDir);
			if (target == null) {
				ctx.ui.notify("No previous directory to return to (use /cd - after a successful /cd).", "warning");
				return;
			}
			if (!isDirectory(target)) {
				ctx.ui.notify(`Not a directory: ${target}`, "error");
				return;
			}
			if (path.resolve(target) === path.resolve(ctx.cwd)) {
				ctx.ui.notify(`Already in ${target}`, "info");
				return;
			}

			const sourceFile = ctx.sessionManager.getSessionFile();
			if (!sourceFile) {
				ctx.ui.notify("Cannot determine current session file — /cd requires a persisted session.", "error");
				return;
			}

			// Check whether the current session has any real conversation content.
			// Fresh sessions from /new contain no "message" entries yet, and
			// SessionManager.forkFrom refuses to fork an empty/invalid file. In that
			// case we create a brand-new session at the target cwd instead of forking.
			const hasContent = ctx.sessionManager.getEntries().some((e) => e.type === "message");

			let newManager: SessionManager;
			try {
				newManager = hasContent
					? SessionManager.forkFrom(sourceFile, target)
					: SessionManager.create(target);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Session switch failed: ${msg}`, "error");
				return;
			}

			const newSessionFile = newManager.getSessionFile();
			if (!newSessionFile) {
				ctx.ui.notify("New session has no file path.", "error");
				return;
			}

			const rememberedPrevious = ctx.cwd;

			// Persistence:
			//  - forkFrom path: append a visible cwd-change notice so the LLM knows
			//    its prior context referred to a different dir. The append also
			//    causes the new session file to be flushed to disk.
			//  - create path: session file is not on disk until an entry is appended,
			//    and ctx.switchSession silently no-ops on a missing file. Append a
			//    pi-cd-init CustomEntry (extension-only, not in LLM context) to
			//    force the file into existence before switching.
			try {
				if (hasContent) {
					newManager.appendCustomMessageEntry(
						"pi-cd-note",
						[
							`[pi-cd] Working directory changed: ${rememberedPrevious} → ${target}`,
							"",
							'From this point on, all relative paths, references to "this folder", "the current directory", "here", etc. refer to the NEW directory.',
							"Earlier turns in this conversation happened in the previous directory; treat those as historical context only — do not assume their paths still apply.",
						].join("\n"),
						true,
					);
				} else {
					newManager.appendCustomEntry("pi-cd-init", {
						target,
						createdAt: new Date().toISOString(),
					});
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Could not persist new session: ${msg}`, "error");
				return;
			}

			const result = await ctx.switchSession(newSessionFile);
			if (result.cancelled) {
				ctx.ui.notify("Directory switch cancelled.", "warning");
				return;
			}

			previousDir = rememberedPrevious;
			ctx.ui.notify(`cwd → ${target}`, "info");
		},
	});
}
