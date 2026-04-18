import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
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

			// Fresh sessions from /new contain no "message" entries yet, and
			// SessionManager.forkFrom refuses to fork an empty/invalid file.
			const hasContent = ctx.sessionManager.getEntries().some((e) => e.type === "message");

			const rememberedPrevious = ctx.cwd;
			let newSessionFile: string;

			try {
				if (hasContent) {
					// forkFrom writes the header + copied source entries directly to
					// disk via appendFileSync, so the file exists immediately.
					const forkedManager = SessionManager.forkFrom(sourceFile, target);
					const file = forkedManager.getSessionFile();
					if (!file) throw new Error("fork returned session with no file path");
					newSessionFile = file;

					// Inject a user-visible cwd-change note so the LLM doesn't keep
					// reasoning about the old directory in subsequent turns. This
					// append succeeds because forkFrom populates fileEntries with
					// any assistant messages the source had, satisfying pi's
					// _persist flush gate.
					try {
						forkedManager.appendCustomMessageEntry(
							"pi-cd-note",
							[
								`[pi-cd] Working directory changed: ${rememberedPrevious} → ${target}`,
								"",
								'From this point on, all relative paths, references to "this folder", "the current directory", "here", etc. refer to the NEW directory.',
								"Earlier turns in this conversation happened in the previous directory; treat those as historical context only — do not assume their paths still apply.",
							].join("\n"),
							true,
						);
					} catch {
						// Non-fatal. Switch still proceeds without the notice.
					}
				} else {
					// SessionManager.create returns a manager with a session_file
					// PATH computed but NOT written to disk — pi's _persist method
					// deliberately defers writes until an assistant message exists
					// (to avoid littering disk with abandoned sessions). In our
					// flow no assistant message ever arrives before we switch,
					// so the file never gets written and ctx.switchSession then
					// silently no-ops on a missing path. We write the session
					// header ourselves, mimicking what forkFrom does, so the
					// file exists on disk when switchSession opens it.
					const tempManager = SessionManager.create(target);
					const file = tempManager.getSessionFile();
					const sessionId = tempManager.getSessionId();
					if (!file || !sessionId) {
						throw new Error("SessionManager.create returned no file path or id");
					}
					const dir = path.dirname(file);
					if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
					const header = {
						type: "session",
						version: CURRENT_SESSION_VERSION,
						id: sessionId,
						timestamp: new Date().toISOString(),
						cwd: target,
					};
					fs.writeFileSync(file, JSON.stringify(header) + "\n");
					newSessionFile = file;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Session creation failed: ${msg}`, "error");
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
