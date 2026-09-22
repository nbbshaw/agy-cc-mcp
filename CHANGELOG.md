# Changelog

## Unreleased

- **Fix: the digest no longer misreports an unstaged change as staged.** The digest
  trimmed the whole `git status --porcelain` output, which removed the leading space of
  the first line. That space is part of git's status code, so an unstaged ` M file` showed
  up as `M file`, which reads as staged. The new test suite found this.

- Add a `node:test` suite, run with `npm test`. It covers the MCP plumbing, every tool,
  the dev loader and release packaging. The suite drives the real server over stdio with a
  scriptable stub in place of agy that records the argv, cwd, env and stdin of every call,
  so it needs no agy install and makes no model call. Stub-based tests run on Linux and
  macOS, or in WSL. On native Windows they are skipped, because node can't spawn a shebang
  script with `shell: false`.

- Add `scripts/check-release.mjs`. It fails when `SERVER_VERSION`, the two manifests and
  this changelog disagree, or when `mcpb/server/agy-bridge.mjs` has drifted from the
  source. That drift is the stale bundle 1.3.0 shipped.

- Add `scripts/pack.mjs`. It builds both `.mcpb` bundles, the standalone script and
  `SHA256SUMS` into `dist/`. It needs no `zip` binary, so it works in PowerShell too. Its
  output is reproducible because line endings and zip timestamps are fixed. It packs the root `agy-bridge.mjs`, so a stale
  `mcpb/server/` copy can no longer ship.

- GitHub Actions: CI runs on every push and PR (Linux on Node 18, 22 and 24, plus macOS
  and Windows) and uploads the built bundles as an artifact. Pushing a `v*` tag reruns CI,
  checks that the tag is on `main` and matches the version, and then publishes a GitHub
  release. The release carries the bundles and checksums, with notes taken from this file.

## 1.3.1

- **Fix: Windows paths are translated in WSL mode instead of refused.** Claude Code on
  Windows passes `cwd` as `C:\Users\you\repo`; the bridge only understood `/mnt/c/...`, so
  every delegation from a Windows session was rejected as "not inside AGY_ALLOWED_ROOTS"
  even when the directory was allowed. Drive paths become `/mnt/<drive>/...` and
  `\\wsl.localhost\<distro>\...` paths become distro paths, for `cwd` on every tool and for
  `add_dir`. Normalisation still runs after translation, so `C:\allowed\..\..` is refused.

- **Fix: the git digest comes from Windows git for repos under `/mnt/<drive>`.** Git inside
  WSL can't follow a worktree's `gitdir: C:/...` pointer, so every Claude Code worktree was
  reported as "not a git repository"; and with `core.autocrlf` it lists every text file in
  a clean checkout as modified. Falls back to git in the distro if Windows git isn't found.

- Add `test/wsl-paths.mjs`: spawns the server with a stub agy in WSL and asserts that a
  Windows `cwd` runs in the translated path, `add_dir` is translated, `..` out of the roots
  is still refused, and the digest's HEAD and touched-path count match Windows git.

- README: a single-line PowerShell form of `claude mcp add`. The multi-line bash form,
  pasted into PowerShell, registers a server whose command is a literal `\`.

## 1.3.0

- **Fix: long delegations no longer die on the client's request timeout.** A real
  `delegate` runs for minutes; an MCP client's per-request timeout is typically 60s. The
  bridge never emitted `notifications/progress`, so every substantial delegation came back
  to the caller as `Error: Request timed out` — while the `agy` process carried on in the
  background and edited the repo anyway. That is the worst of both worlds: the work landed,
  the caller was told it had failed, and the digest was lost.

  `tools/call` now starts a 10s heartbeat for the life of the call whenever the client
  supplied a `progressToken` in `params._meta` — which is precisely the mechanism the MCP
  spec provides for this, since each notification carrying that token resets the client's
  timeout for that request. `progress` counts elapsed seconds (it must increase
  monotonically) and `total` is the run's own `timeout_seconds` when it has one, so the
  client can render a real bar rather than a spinner.

  A client that sends no `progressToken` receives no notifications and sees exactly the old
  behaviour, so this cannot regress one that does not want them.

- Add `test/progress-heartbeat.mjs`, the first test in this repo. It spawns the server over
  real stdio and asserts both halves: that a long call with a `progressToken` produces
  monotonic notifications carrying that exact token, and that a call without one produces
  none. It also checks the stdout stream stays parseable line by line — a notification
  written carelessly would corrupt every response after it, which is a far worse failure than
  the one being fixed. Needs no agy install and makes no model call: `AGY_BIN` points at a
  shell stub that sleeps. `AGY_PROGRESS_INTERVAL_MS` exists so the test can drive the beat
  faster than the 10s default.

  Run it against either copy — `node test/progress-heartbeat.mjs` for the working source,
  `node test/progress-heartbeat.mjs mcpb/server/agy-bridge.mjs` for the one that gets packed.
  Keeping those two in sync is manual, and this release shipped a `.mcpb` built from a stale
  `mcpb/server/` copy before that was noticed.

## 1.2.4

- Add `agy-bridge-dev.mcpb`: loads the bridge from a working copy on disk so iterating
  needs a server restart rather than a repack and reinstall.

- Fix: commands were corrupted crossing the Windows argv → `wsl.exe` → bash boundary
  (`unexpected EOF while looking for matching '"'`) once they contained more than a
  couple of double quotes. The inner script is now base64-encoded so the Windows command
  line carries no quotes or backslashes, and is decoded to a temp file rather than piped
  into bash, which keeps the caller's stdin connected.

## 1.2.3

- Poll for the plan artifact for ~7s: agy links it in its response before the file
  exists on disk.
- `run()` now settles 1.5s after the child exits instead of waiting for stdio EOF, so a
  lingering grandchild that inherited stdout can't stall a call until its timeout.

## 1.2.2

- Plan artifact lookup no longer assumes agy's directory layout — searches for the
  conversation id, prefers a filename containing "plan", excludes `walkthrough.md`.
- Reports what it did find when the lookup fails, instead of silently omitting the section.

## 1.2.1

- Verify the served model by pointing `--log-file` at a scratch file and reading the slug
  back, since agy's JSON does not report it and `-p` substitutes silently.
- Find the plan artifact under any filename, not just `implementation_plan.md`.

## 1.2.0

- `delegate` gains `mode` (`accept-edits` | `plan`). Plan mode is the headless equivalent
  of `/plan`; verified as a real write barrier.
- Surface `denied_actions`: agy reports `SUCCESS` with an empty response when headless
  auto-denies every tool call, which is otherwise indistinguishable from a normal run.
- Case-insensitive status check (agy returns `SUCCESS`, not `success`).
- `add_dir` → `--add-dir`.

## 1.1.0

- `command`, `raw` and `help` tools: agy slash commands, arbitrary argv, and runtime
  discovery of what this agy version supports.
- Strip metered API/Vertex credentials from every run so work bills to the signed-in
  Google plan.

## 1.0.0

- Initial release: `delegate`, `models`, `doctor`; allowed-roots enforcement, response
  clamping with on-disk transcripts, git diffstat after write runs.
