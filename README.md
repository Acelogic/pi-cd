# pi-cd

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that adds a `/cd <path>` command for switching the session's working directory without leaving pi.

pi normally fixes `cwd` at session creation; built-in bash `cd` only affects subprocesses. This extension forks the current session into the target directory (via `SessionManager.forkFrom` + `ctx.switchSession`), so conversation history is preserved.

## Usage

Inside pi:

```text
/cd ~/Developer/some-project
/cd ../sibling
/cd /absolute/path
/cd -            # back to previous directory
/cd              # home ($HOME)
```

Tab completion offers matching directories.

## Install

```bash
pi install git:github.com/Acelogic/pi-cd
```

## Update

```bash
pi update git:github.com/Acelogic/pi-cd
```

Then `/reload` inside pi.

## Caveats

- Switching sessions replays the conversation in the new session — there's a brief reload.
- Session files live in the session dir determined by pi; a forked session is a **new file** in that directory (not an edit of the old one). Your original session is preserved and can be resumed via `pi --resume`.
- Symlinks are resolved via `fs.realpathSync.native` to match how pi records `cwd`.
