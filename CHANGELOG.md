# Changelog

## 1.2.4

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
