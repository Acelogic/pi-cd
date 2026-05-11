import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

const STATE_ENTRY_TYPE = "pi-cd-state";
const NOTE_ENTRY_TYPE = "pi-cd-note";

type CdState = {
	previousDir: string | null;
};

function restorePreviousDir(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	let restored: string | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (data == null || typeof data !== "object") {
			restored = null;
			continue;
		}
		const previousDir = (data as Partial<CdState>).previousDir;
		restored = typeof previousDir === "string" ? previousDir : null;
	}
	return restored;
}

function writeSessionNow(manager: SessionManager): void {
	const sessionFile = manager.getSessionFile();
	const header = manager.getHeader();
	if (!sessionFile || !header) throw new Error("session manager has no writable file/header");
	const dir = path.dirname(sessionFile);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const entries = [header, ...manager.getEntries()];
	fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function appendCwdChangeMetadata(manager: SessionManager, previousDir: string, target: string): void {
	manager.appendCustomMessageEntry(
		NOTE_ENTRY_TYPE,
		[
			`[pi-cd] Working directory changed: ${previousDir} → ${target}`,
			"",
			'From this point on, all relative paths, references to "this folder", "the current directory", "here", etc. refer to the NEW directory.',
			"Earlier turns in this conversation happened in the previous directory; treat those as historical context only — do not assume their paths still apply.",
		].join("\n"),
		true,
	);
	manager.appendCustomEntry(STATE_ENTRY_TYPE, {
		previousDir,
	} satisfies CdState);

	// SessionManager intentionally defers writes until an assistant message exists.
	// /cd may run in an empty/user-only session, so force the fork/create result to
	// disk before switchSession tries to open it and before the new extension
	// instance restores /cd - state during session_start.
	writeSessionNow(manager);
}

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
	let currentCwd = process.cwd();

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		previousDir = restorePreviousDir(ctx);
	});

	pi.registerCommand("cd", {
		description: "Switch the session's working directory (forks into target cwd)",
		getArgumentCompletions: (prefix) => {
			const items = completeDirs(prefix, currentCwd);
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
					appendCwdChangeMetadata(forkedManager, rememberedPrevious, target);
					newSessionFile = file;
				} else {
					// SessionManager.create returns a manager with a session_file path
					// computed but not written to disk. appendCwdChangeMetadata forces
					// the header + /cd metadata out before switchSession opens it.
					const tempManager = SessionManager.create(target);
					const file = tempManager.getSessionFile();
					if (!file) throw new Error("SessionManager.create returned no file path");
					appendCwdChangeMetadata(tempManager, rememberedPrevious, target);
					newSessionFile = file;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Session creation failed: ${msg}`, "error");
				return;
			}

			const result = await ctx.switchSession(newSessionFile, {
				withSession: async (newCtx) => {
					newCtx.ui.notify(`cwd → ${target}`, "info");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Directory switch cancelled.", "warning");
				return;
			}
		},
	});
}
