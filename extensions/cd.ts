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

			let newManager: SessionManager;
			try {
				newManager = SessionManager.forkFrom(sourceFile, target);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Fork failed: ${msg}`, "error");
				return;
			}

			const newSessionFile = newManager.getSessionFile();
			if (!newSessionFile) {
				ctx.ui.notify("Fork returned a session with no file path.", "error");
				return;
			}

			const rememberedPrevious = ctx.cwd;

			// Inject an explicit, in-conversation notice so the LLM knows the cwd
			// changed. Without this, the forked session inherits history that
			// references the old cwd and the model keeps reasoning about the old
			// directory when the user says "this folder".
			try {
				newManager.appendCustomMessageEntry(
					"pi-cd-note",
					[
						`[pi-cd] Working directory changed: ${rememberedPrevious} → ${target}`,
						"",
						"From this point on, all relative paths, references to \"this folder\", \"the current directory\", \"here\", etc. refer to the NEW directory.",
						"Earlier turns in this conversation happened in the previous directory; treat those as historical context only — do not assume their paths still apply.",
					].join("\n"),
					true,
				);
			} catch (err) {
				// Non-fatal — switch still proceeds, just without the notice.
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Could not inject cwd-change notice: ${msg}`, "warning");
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
