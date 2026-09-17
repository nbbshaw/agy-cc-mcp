# agy-bridge

An MCP server that exposes the [Google Antigravity CLI](https://antigravity.google/docs/cli/getting-started) (`agy`)
to Claude Code, Claude Desktop, and Cowork — so Claude can hand test-writing and other
mechanical coding work to Gemini and get back a digest plus a git diff instead of a wall
of output.

- **One file, no dependencies.** Node 18+, stdio MCP transport, ~700 lines.
- **Runs on your Google plan.** Metered API-key and Vertex credentials are stripped from
  every child process, so a run either uses the account from `agy login` or it fails.
- **Context-cheap by design.** The response is clamped; the full transcript goes to disk.
- **Works from Windows against agy in WSL**, without a second install or login.

Not affiliated with Google or Anthropic.

---

## Install

### 1. agy itself

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
exec $SHELL -l
agy login          # browser OAuth
agy models         # note which slugs you actually have
```

Check that `~/.gemini/antigravity-cli/settings.json` does **not** set
`"modelProvider": "gemini"` — that is the API-key path and bypasses your plan.

`agy models` is authoritative. If the slug you pin isn't in that list, Antigravity
substitutes another one silently in `-p` mode
([antigravity-cli#687](https://github.com/google-antigravity/antigravity-cli/issues/687)).

### 2. Claude Desktop / Cowork — install the extension

Download `agy-bridge.mcpb` and double-click it, or Settings → Extensions → Advanced
settings → Install Extension…

> Recent Claude Desktop builds **ignore `mcpServers` in `claude_desktop_config.json`**.
> Local MCP servers are installed as `.mcpb` extensions. On an MSIX/Store install the
> app's config also lives under
> `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`, not `%APPDATA%\Claude\`.
> If you edit that file and nothing happens, this is why.

Settings the installer asks for:

| Setting | Notes |
|---|---|
| WSL distro | e.g. `Ubuntu-26.04` — check `wsl -l -q`. Leave **empty** on macOS/Linux or if agy is installed natively on Windows. |
| Allowed write roots | Colon-separated dirs Gemini may write in, as the machine running agy sees them (WSL paths when a distro is set). |
| Default model | `gemini-3.8-flash-high` |
| Digest size | Response chars kept in Claude's context. |
| agy binary | Leave as `agy` unless it isn't on PATH. |

Once installed, Cowork reaches it through the desktop bridge as
`mcp__remote-devices__…__delegate` and friends.

### 3. Claude Code

Claude Code reads its own config, unaffected by the above:

```bash
claude mcp add agy --scope user \
  -e AGY_ALLOWED_ROOTS=/home/you/code \
  -e AGY_DEFAULT_MODEL=gemini-3.8-flash-high \
  -- node /path/to/agy-bridge.mjs
```

User scope makes the tools available to every project and to subagents — which is what
lets Ultracode workflow agents delegate.

### 4. Optional

- `CLAUDE-md-snippet.md` → your `CLAUDE.md`, so Claude knows *when* to delegate.
- `agents/gemini-delegate.md` → `~/.claude/agents/`, a subagent that can only delegate
  and verify, never quietly do the work itself.
- `workflows/delegate-tests.mjs` → a worked Ultracode example: Claude surveys what needs
  coverage, Gemini writes each suite in parallel, Claude runs and reviews them.

---

## Tools

| Tool | What it does |
|---|---|
| `delegate` | Runs `agy -p` with your brief. Returns status, the model actually served, token usage, `conversation_id`, git diffstat, and a clamped response. |
| `command` | Runs an agy slash command — `/usage`, `/permissions`, `/mcp`, `/model`, `/changelog`. |
| `help` | `agy --help` plus this install's slash-command list. |
| `raw` | Arbitrary argv, optional stdin. Auth and self-update subcommands refused. |
| `models` | `agy models`. |
| `doctor` | Binary, version, auth path, billing enforcement, effective config. Run first when something breaks. |

### Plan mode

`/plan` is TUI-only and not available in print mode, but `agy --mode plan` is — and it is
a genuine write barrier, not a prompt-level request. Verified: instructed to create a file
in the repo, agy in plan mode diverted it to its own scratch directory and the repo stayed
clean. `delegate` takes `mode: "plan"`, auto-approves permissions (without which the run is
silently auto-denied), and reads the resulting `implementation_plan.md` artifact back into
the response.

Shell commands still execute in plan mode. The barrier is on file writes, not execution.

### Model verification

agy's JSON doesn't report which model served the run, so a substitution would be invisible.
The bridge points `--log-file` at a scratch file and recovers the served slug from it,
warning when it differs from what was requested.

---

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `AGY_BIN` | `agy` | Path to the binary. |
| `AGY_WSL_DISTRO` | — | Run everything via `wsl.exe -d <distro>`. |
| `AGY_ALLOWED_ROOTS` | — | Dirs agy may work in. Unset = write delegation refused. |
| `AGY_DEFAULT_MODEL` | `gemini-3.8-flash-high` | Model when none is pinned. |
| `AGY_MAX_CHARS` | `6000` | Response chars kept in the digest. |
| `AGY_TIMEOUT_SEC` | `900` | Default `delegate` timeout. |
| `AGY_TRANSCRIPT_DIR` | `<tmp>/agy-bridge` | Full transcripts. |
| `AGY_FORCE_OAUTH` | `1` | Strip metered credentials. `0` to allow API-key billing. |
| `AGY_RAW_DENY` | `login,logout,auth,update,upgrade,uninstall` | Subcommands `raw` refuses. |
| `AGY_DISABLE_RAW` | — | `1` removes the `raw` tool. |

## Caveats

**Write mode passes `--dangerously-skip-permissions`**, which approves every tool call in
that run including shell commands. `AGY_ALLOWED_ROOTS` bounds where such a run may start;
it does not sandbox what happens inside. Delegate on a branch and read the diff.

**`write: false` is not read-only** — it withholds permissions, so tool calls are
auto-denied and you get an empty response. Use `mode: "plan"` for read-only work.

**agy reports `SUCCESS` even when every tool call was denied.** The bridge surfaces
`denied_actions` because an empty response otherwise looks like a model with nothing to say.

**Briefs are self-contained.** The delegate sees your repo, not your conversation.

## Developing on the bridge

The packaged `.mcpb` carries its own copy of `agy-bridge.mjs`, so editing the source has
no effect until you repack and reinstall. `agy-bridge-dev.mcpb` avoids that loop: it
contains only a loader that imports whatever file you point **Bridge source file** at, so
an edit takes effect on the next server restart.

```
Settings -> Extensions -> Install Extension... -> agy-bridge-dev.mcpb
  Bridge source file: <your working copy of agy-bridge.mjs>
```

Disable the packaged extension while the dev one is enabled — both expose the same tool
names, and having two servers answering to `delegate` is nothing but confusing. Repack for
normal use with:

```bash
cp agy-bridge.mjs mcpb/server/agy-bridge.mjs
cd mcpb && zip -r ../agy-bridge.mcpb manifest.json server   # or: mcpb pack
```

## Implementation notes

Two things that cost real debugging time, recorded so they don't have to again:

- **Windows → `wsl.exe` → bash mangles quotes.** A command with a few double quotes
  survives; one with many comes out as `unexpected EOF while looking for matching '"'`.
  The bridge base64-encodes the script so the Windows command line contains no quotes or
  backslashes at all, and decodes to a temp file (rather than piping into bash) to keep
  stdin connected.
- **agy names artifacts before writing them.** The response links
  `implementation_plan.md` while the file isn't on disk yet, so the bridge polls for ~7s.
  Related: `run()` settles shortly after process exit rather than waiting for stdio EOF,
  so a lingering grandchild holding stdout can't stall a call until its timeout.

## License

MIT
