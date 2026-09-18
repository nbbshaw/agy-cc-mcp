# Changelog

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
