#!/usr/bin/env node
/**
 * agy-bridge — an MCP server that exposes the Google Antigravity CLI (`agy`)
 * as a delegation target for Claude Code, Claude Desktop, and (via the desktop
 * bridge) Cowork.
 *
 * Zero dependencies. Node 18+. stdio transport, newline-delimited JSON-RPC.
 *
 * Tools:
 *   delegate — run a task on a Gemini model via `agy -p`, return a compact digest
 *   command  — run an agy slash command (/plan, /usage, /teamwork-preview, …)
 *   raw      — run agy with arbitrary argv; the escape hatch for any flag
 *   help     — discover this install's flags and slash commands
 *   models   — list the model slugs this agy install can actually reach
 *   doctor   — check binary, version, auth, and bridge configuration
 *
 * Environment:
 *   AGY_BIN            path to the agy binary            (default: "agy")
 *   AGY_WSL_DISTRO     if set, every command is run as `wsl.exe -d <distro> -- bash -lc ...`
 *                      (use this when the MCP client runs on Windows but agy lives in WSL).
 *                      In WSL mode all paths are WSL paths, e.g. /home/you/code/repo
 *   AGY_ALLOWED_ROOTS  path-separated list of directories delegation may run in.
 *                      Required for write mode. Separator is ":" except on native
 *                      Windows without AGY_WSL_DISTRO, where it is ";"
 *   AGY_DEFAULT_MODEL  default model slug                (default: "gemini-3.8-flash-high")
 *   AGY_MAX_CHARS      max chars of agy response kept in the digest (default: 6000)
 *   AGY_TIMEOUT_SEC    default per-call timeout in seconds (default: 900)
 *   AGY_TRANSCRIPT_DIR where full transcripts are written (default: <tmp>/agy-bridge)
 *   AGY_RAW_DENY       comma-separated subcommands the `raw` tool refuses
 *                      (default: "login,logout,auth,update,upgrade,uninstall")
 *   AGY_DISABLE_RAW    set to "1" to remove the `raw` tool entirely
 *   AGY_FORCE_OAUTH    "1" (default) strips GEMINI_API_KEY / Vertex credentials from the
 *                      child environment so every run bills against your signed-in Google
 *                      plan instead of silently falling back to metered API keys.
 *                      Set to "0" only if you deliberately want API-key billing.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const SERVER_NAME = "agy-bridge";
const SERVER_VERSION = "1.2.4";
const DEFAULT_PROTOCOL = "2025-06-18";

const toInt = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const WSL_DISTRO = (process.env.AGY_WSL_DISTRO || "").trim();
const USE_WSL = WSL_DISTRO.length > 0;
const IS_WIN = process.platform === "win32" && !USE_WSL;
const ROOT_SEP = IS_WIN ? ";" : ":";

const CFG = {
  bin: process.env.AGY_BIN || "agy",
  defaultModel: process.env.AGY_DEFAULT_MODEL || "gemini-3.8-flash-high",
  maxChars: toInt(process.env.AGY_MAX_CHARS, 6000),
  timeoutSec: toInt(process.env.AGY_TIMEOUT_SEC, 900),
  allowedRoots: (process.env.AGY_ALLOWED_ROOTS || "")
    .split(ROOT_SEP)
    .map((s) => s.trim())
    .filter(Boolean),
  transcriptDir: process.env.AGY_TRANSCRIPT_DIR || path.join(tmpdir(), "agy-bridge"),
  rawDeny: (process.env.AGY_RAW_DENY ?? "login,logout,auth,update,upgrade,uninstall")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  rawDisabled: process.env.AGY_DISABLE_RAW === "1",
  forceOauth: process.env.AGY_FORCE_OAUTH !== "0",
};

/**
 * Credentials that would make agy bill a metered API/Vertex path instead of the
 * Google plan you signed into with `agy login`.
 */
const METERED_AUTH_VARS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "VERTEXAI_PROJECT",
  "VERTEXAI_LOCATION",
];

// agy installs to ~/.local/bin, which is often missing from a GUI app's PATH.
const augmentedEnv = () => {
  const env = { ...process.env };
  if (CFG.forceOauth) for (const k of METERED_AUTH_VARS) delete env[k];
  if (!USE_WSL && !IS_WIN) {
    const extra = [
      path.join(homedir(), ".local", "bin"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ];
    const sep = path.delimiter;
    const current = (env.PATH || "").split(sep);
    for (const dir of extra) if (!current.includes(dir)) current.push(dir);
    env.PATH = current.filter(Boolean).join(sep);
  }
  // agy is a TUI-aware binary; make sure it never tries to be interactive.
  env.CI = env.CI || "1";
  env.TERM = env.TERM || "dumb";
  env.NO_COLOR = "1";
  return env;
};

// ---------------------------------------------------------------------------
// path handling
// ---------------------------------------------------------------------------

const normalizePath = (p) => {
  if (!p) return p;
  if (USE_WSL || !IS_WIN) return path.posix.normalize(p.replace(/\\/g, "/"));
  return path.win32.normalize(p);
};

const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

const isInside = (root, child) => {
  const r = normalizePath(root).replace(/[\\/]+$/, "");
  const c = normalizePath(child).replace(/[\\/]+$/, "");
  if (samePath(r, c)) return true;
  const prefix = r + (IS_WIN ? "\\" : "/");
  return IS_WIN
    ? c.toLowerCase().startsWith(prefix.toLowerCase())
    : c.startsWith(prefix);
};

const rootCheck = (cwd) => {
  if (CFG.allowedRoots.length === 0) return { ok: false, reason: "unset" };
  for (const root of CFG.allowedRoots) if (isInside(root, cwd)) return { ok: true };
  return { ok: false, reason: "outside" };
};

const defaultCwd = () => CFG.allowedRoots[0] || (USE_WSL ? "/" : process.cwd());

// ---------------------------------------------------------------------------
// process execution
// ---------------------------------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run a command, optionally through WSL. Returns {code, signal, stdout, stderr, timedOut}.
 * Never throws for a non-zero exit.
 */
function run(bin, args, { cwd, timeoutMs, stdin }) {
  return new Promise((resolve) => {
    let child;
    if (USE_WSL) {
      // `bash -lc` sources the WSL user's profile, so a GEMINI_API_KEY exported
      // there would survive scrubbing on the Windows side. Unset it inside too.
      const scrub = CFG.forceOauth ? `unset ${METERED_AUTH_VARS.join(" ")}; ` : "";
      const inner = `${scrub}cd ${shq(cwd)} && ${[bin, ...args].map(shq).join(" ")}`;

      // Anything with quotes in it is corrupted crossing the Windows argv →
      // wsl.exe → bash boundary ("unexpected EOF while looking for matching"),
      // so ship the script base64-encoded: the command line that Windows sees
      // then contains no quotes or backslashes at all. Decoding to a temp file
      // rather than piping into bash keeps the caller's stdin connected.
      const b64 = Buffer.from(inner, "utf8").toString("base64");
      const tmp = `/tmp/agy-bridge-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`;
      const launcher =
        `echo ${b64} | base64 -d > ${tmp}; bash ${tmp}; rc=$?; rm -f ${tmp}; exit $rc`;

      child = spawn("wsl.exe", ["-d", WSL_DISTRO, "--", "bash", "-lc", launcher], {
        env: augmentedEnv(),
        windowsHide: true,
      });
    } else {
      child = spawn(bin, args, {
        cwd,
        env: augmentedEnv(),
        windowsHide: true,
        shell: false,
      });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    // Print mode can block forever if stdin stays open with nothing on it.
    try {
      if (stdin) child.stdin?.write(stdin.endsWith("\n") ? stdin : stdin + "\n");
      child.stdin?.end();
    } catch {}

    const finish = (code, signal, errMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr: errMsg ? `${stderr}${stderr ? "\n" : ""}${errMsg}` : stderr,
        timedOut,
      });
    };

    child.on("error", (err) => finish(null, null, `spawn failed: ${err.message}`));
    child.on("close", (code, signal) => finish(code, signal));
    // 'close' waits for every stdio consumer to hang up, so a lingering background
    // grandchild that inherited stdout would stall the call until its timeout.
    // Once the process itself has exited, allow a short flush window and move on.
    child.on("exit", (code, signal) => {
      setTimeout(() => finish(code, signal), 1500);
    });
  });
}

const runAgy = (args, opts) => run(CFG.bin, args, opts);

async function gitInfo(cwd) {
  const head = await run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
    cwd,
    timeoutMs: 15000,
  });
  if (head.code !== 0) return null;
  const [stat, status] = await Promise.all([
    run("git", ["-C", cwd, "diff", "--stat"], { cwd, timeoutMs: 20000 }),
    run("git", ["-C", cwd, "status", "--porcelain=v1"], { cwd, timeoutMs: 20000 }),
  ]);
  return {
    head: head.stdout.trim(),
    diffstat: stat.stdout.trim(),
    porcelain: status.stdout.trim(),
  };
}

// ---------------------------------------------------------------------------
// agy output parsing
// ---------------------------------------------------------------------------

/** agy --output-format json prints one object; be forgiving about stray lines. */
function parseAgyJson(stdout) {
  const raw = stdout.trim();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v;
  } catch {}
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return null;
}

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

/** Keep the head and the tail; the middle of a long reply is the least useful part. */
function clamp(text, limit) {
  if (!text) return "";
  if (text.length <= limit) return text;
  const headLen = Math.floor(limit * 0.6);
  const tailLen = limit - headLen;
  const omitted = text.length - limit;
  return (
    text.slice(0, headLen) +
    `\n\n…[${omitted.toLocaleString()} chars omitted — full transcript on disk]…\n\n` +
    text.slice(text.length - tailLen)
  );
}

function saveTranscript(id, body) {
  try {
    mkdirSync(CFG.transcriptDir, { recursive: true });
    const safe = String(id || Date.now()).replace(/[^A-Za-z0-9._-]/g, "_");
    const file = path.join(CFG.transcriptDir, `${safe}.md`);
    writeFileSync(file, body, "utf8");
    return file;
  } catch {
    return null;
  }
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * Plan mode writes its artifact to ~/.gemini/antigravity-cli/brain/<id>/implementation_plan.md
 * on whichever machine agy runs. Fetch it so the plan lands in the digest rather than
 * only as a path the caller cannot open.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * agy names the artifact in its response before the file has landed on disk, so a
 * read immediately after the process exits finds an empty directory. Poll briefly.
 */
async function readPlanArtifact(conversationId) {
  const delays = [0, 600, 1200, 2000, 3000];
  let last = null;
  for (const d of delays) {
    if (d) await sleep(d);
    const got = await readPlanArtifactOnce(conversationId);
    if (got && !got.missing) return got;
    last = got;
  }
  if (last?.missing) {
    last.diagnostic = `${last.diagnostic}\n  (retried for ~7s after agy exited)`;
  }
  return last;
}

async function readPlanArtifactOnce(conversationId) {
  const id = String(conversationId || "");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  // Don't assume the layout: agy names the plan after the task rather than always
  // implementation_plan.md, and the brain directory has moved between versions.
  // Search the agy state tree for anything belonging to this conversation.
  const base = `$HOME/.gemini/antigravity-cli`;
  const script =
    `c=$(find "${base}" -maxdepth 6 -type f -name '*.md' -path "*${id}*" ! -name 'walkthrough.md' 2>/dev/null); ` +
    `f=$(printf '%s\\n' "$c" | grep -i plan | head -1); ` +
    `[ -z "$f" ] && f=$(printf '%s\\n' "$c" | head -1); ` +
    `if [ -n "$f" ]; then echo "@@FILE@@$f"; cat "$f"; ` +
    `else echo "@@NONE@@"; find "${base}" -maxdepth 6 -path "*${id}*" 2>/dev/null | head -20; fi`;
  try {
    const res = await run("sh", ["-c", script], {
      cwd: USE_WSL ? "/" : defaultCwd(),
      timeoutMs: 25000,
    });
    const out = res.stdout || "";
    const marker = out.indexOf("@@FILE@@");
    if (marker < 0) {
      const none = out.indexOf("@@NONE@@");
      const seen = none >= 0 ? out.slice(none + "@@NONE@@".length).trim() : "";
      return {
        missing: true,
        diagnostic: seen
          ? `no plan .md found for this conversation. Paths matching the id:\n${clamp(seen, 800)}`
          : `no plan artifact found under ~/.gemini/antigravity-cli for this conversation` +
            (res.stderr.trim() ? ` (stderr: ${res.stderr.trim().slice(0, 200)})` : ""),
      };
    }
    const nl = out.indexOf("\n", marker);
    if (nl < 0) return null;
    const file = out.slice(marker + "@@FILE@@".length, nl).trim();
    const body = out.slice(nl + 1);
    if (!body.trim()) return null;
    return { path: file, body };
  } catch {
    return null;
  }
}

const KNOWN_SLUG_RE =
  /(?:gemini-[0-9][0-9.]*-(?:flash|pro)-(?:low|medium|high)|claude-[a-z0-9.-]*[0-9](?:-thinking)?|gpt-oss-[0-9a-z-]+)/gi;

/**
 * agy's JSON does not report which model actually served the run, and `-p` mode
 * substitutes unavailable slugs silently. The CLI log does record the resolution,
 * so point --log-file at a scratch file and read the model back out of it.
 */
async function readServedModel(logPath) {
  const script =
    `grep -aiE 'model' ${logPath} 2>/dev/null | tail -60; rm -f ${logPath} 2>/dev/null`;
  try {
    const res = await run("sh", ["-c", script], {
      cwd: USE_WSL ? "/" : defaultCwd(),
      timeoutMs: 15000,
    });
    const text = res.stdout || "";
    if (!text.trim()) return null;
    const hits = text.match(KNOWN_SLUG_RE);
    if (!hits || !hits.length) return null;
    // Last mention wins: resolution happens before the turn runs.
    return { slug: hits[hits.length - 1].toLowerCase(), distinct: [...new Set(hits.map((h) => h.toLowerCase()))] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tool: delegate
// ---------------------------------------------------------------------------

async function toolDelegate(args) {
  const task = String(args.task ?? "").trim();
  if (!task) return err("`task` is required and must be a non-empty brief.");

  const cwd = normalizePath(String(args.cwd ?? "").trim());
  if (!cwd) return err("`cwd` is required (absolute path to the working directory).");

  const mode = args.mode === "plan" || args.mode === "accept-edits" ? args.mode : null;
  const planMode = mode === "plan";
  // Plan mode is a workspace write barrier enforced by agy itself, so `write` is
  // meaningless there; permissions are still auto-approved or the run is auto-denied.
  const write = planMode ? false : args.write !== false;
  const skipPermissions = planMode ? args.strict_permissions !== true : write;

  // Shell commands still execute in plan mode, so the root check applies either way.
  const check = rootCheck(cwd);
  if (!check.ok && (write || planMode)) {
    if (check.reason === "unset") {
      return err(
        "AGY_ALLOWED_ROOTS is not set on the bridge, so this run is refused. " +
          "Set it to the directories agy may work in, or call again with write=false and no mode."
      );
    }
    return err(
      `Refusing to run in ${cwd} — it is not inside AGY_ALLOWED_ROOTS ` +
        `(${CFG.allowedRoots.join(", ")}). Use a path inside an allowed root, or call again with write=false.`
    );
  }

  const model = String(args.model || CFG.defaultModel);
  const timeoutSec = toInt(args.timeout_seconds, CFG.timeoutSec);
  const slugEncodesEffort = /-(low|medium|high)$/.test(model);

  const agyArgs = [
    "-p",
    task,
    "--model",
    model,
    "--output-format",
    "json",
    "--print-timeout",
    `${timeoutSec}s`,
  ];
  if (args.effort && !slugEncodesEffort) agyArgs.push("--effort", String(args.effort));
  if (args.agent) agyArgs.push("--agent", String(args.agent));
  if (mode) agyArgs.push("--mode", mode);
  if (args.conversation_id) agyArgs.push("--conversation", String(args.conversation_id));
  if (Array.isArray(args.add_dir)) for (const d of args.add_dir) agyArgs.push("--add-dir", String(d));
  if (skipPermissions) agyArgs.push("--dangerously-skip-permissions");
  if (args.sandbox === true) agyArgs.push("--sandbox");

  // Scratch log purely so the served model can be verified afterwards.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath =
    USE_WSL || !IS_WIN
      ? `/tmp/agy-bridge-${runId}.log`
      : path.join(tmpdir(), `agy-bridge-${runId}.log`);
  agyArgs.push("--log-file", logPath);

  if (Array.isArray(args.extra_args)) agyArgs.push(...args.extra_args.map(String));

  const before = write ? await gitInfo(cwd) : null;
  const started = Date.now();
  const res = await runAgy(agyArgs, { cwd, timeoutMs: (timeoutSec + 30) * 1000 });
  const wall = ((Date.now() - started) / 1000).toFixed(1);

  if (res.timedOut) {
    return err(
      `agy was killed after ${timeoutSec}s. Partial stderr:\n${clamp(res.stderr, 1500)}\n\n` +
        `Re-run with a larger timeout_seconds, or split the task.`
    );
  }
  if (res.code !== 0 && !res.stdout.trim()) {
    return err(
      `agy exited ${res.code}.\nstderr:\n${clamp(res.stderr, 2500) || "(empty)"}\n\n` +
        `Run the 'doctor' tool to check the binary and auth.`
    );
  }

  const parsed = parseAgyJson(res.stdout);
  const response = parsed
    ? String(pick(parsed, "response", "result", "text", "stdout.response") ?? "")
    : res.stdout;
  const conversationId = parsed ? pick(parsed, "conversation_id", "stdout.conversation_id") : undefined;
  const status = parsed ? pick(parsed, "status", "stdout.status") : undefined;
  const agyError = parsed ? pick(parsed, "error", "stdout.error") : undefined;
  const duration = parsed ? pick(parsed, "duration_seconds", "stdout.duration_seconds") : undefined;
  const turns = parsed ? pick(parsed, "num_turns", "stdout.num_turns") : undefined;
  const usage = parsed ? pick(parsed, "usage", "stdout.usage") : undefined;
  const reportedModel = parsed
    ? pick(parsed, "model", "model_slug", "usage.model", "stdout.model")
    : undefined;
  const deniedRaw = parsed ? pick(parsed, "denied_actions", "stdout.denied_actions") : undefined;
  const denied = Array.isArray(deniedRaw) ? deniedRaw : [];
  const statusOk = String(status ?? "").toLowerCase() === "success";

  const after = write ? await gitInfo(cwd) : null;
  const plan = planMode ? await readPlanArtifact(conversationId) : null;
  const served = reportedModel ? null : await readServedModel(logPath);

  const transcript = saveTranscript(conversationId || `run-${Date.now()}`, [
    `# agy delegation`,
    ``,
    `- requested model: ${model}`,
    `- reported model: ${reportedModel ?? "(not reported)"}`,
    `- cwd: ${cwd}`,
    `- write: ${write}`,
    `- mode: ${mode ?? "(default)"}`,
    `- argv: ${JSON.stringify(agyArgs)}`,
    `- conversation_id: ${conversationId ?? "(none)"}`,
    ``,
    `## Brief`,
    ``,
    task,
    ``,
    `## Response`,
    ``,
    response || "(empty)",
    ``,
    `## stderr`,
    ``,
    res.stderr || "(empty)",
    ``,
  ].join("\n"));

  const lines = [];
  lines.push(
    `agy ${statusOk || res.code === 0 ? "ok" : `status=${status ?? res.code}`} · ` +
      `${wall}s wall${duration ? ` (agy ${duration}s)` : ""}${turns ? ` · ${turns} turns` : ""}` +
      `${mode ? ` · mode=${mode}` : ""}`
  );

  // agy reports SUCCESS even when every tool call was auto-denied, which looks
  // identical to a real run except the response is empty. Say so loudly.
  if (denied.length) {
    const names = denied
      .map((d) => (typeof d === "string" ? d : d?.display_name || d?.action || JSON.stringify(d)))
      .join(", ");
    lines.push(
      `WARNING: ${denied.length} tool call(s) auto-denied in headless mode: ${names}.`,
      `  agy still reports SUCCESS, so an empty or shallow response here means the work did NOT happen.`,
      `  Re-run allowing permissions (write=true, or mode=plan which auto-approves while blocking edits),`,
      `  or add an allow-rule under permissions.allow in ~/.gemini/antigravity-cli/settings.json.`
    );
  }

  lines.push(`model requested: ${model}`);
  if (reportedModel) {
    lines.push(`model reported:  ${reportedModel}`);
    if (String(reportedModel) !== model) {
      lines.push(
        `WARNING: agy served a different model than requested. Antigravity silently substitutes ` +
          `unavailable slugs in -p mode. Treat the result accordingly.`
      );
    }
  } else if (served) {
    lines.push(`model served:    ${served.slug}  (read from agy's own log)`);
    if (served.slug !== model) {
      lines.push(
        `WARNING: agy served a different model than requested. Antigravity silently substitutes ` +
          `unavailable slugs in -p mode. Treat the result accordingly.` +
          (served.distinct.length > 1 ? ` Slugs seen in log: ${served.distinct.join(", ")}.` : "")
      );
    }
  } else {
    lines.push(`model served:    (not determinable — agy reported no model and its log named none)`);
  }
  if (usage) lines.push(`usage: ${JSON.stringify(usage)}`);
  if (conversationId) lines.push(`conversation_id: ${conversationId}  (pass this back to continue)`);
  if (agyError) lines.push(`agy error field: ${String(agyError)}`);

  if (write) {
    lines.push("");
    if (!after) {
      lines.push("git: not a git repository — no diff available, inspect the files directly.");
    } else {
      const changed = after.porcelain ? after.porcelain.split(/\r?\n/).length : 0;
      lines.push(`git HEAD ${after.head} · ${changed} path(s) touched`);
      if (before && before.head !== after.head) {
        lines.push(`NOTE: HEAD moved (${before.head} → ${after.head}) — Gemini committed.`);
      }
      if (after.diffstat) lines.push(clamp(after.diffstat, 1500));
      if (after.porcelain) lines.push(clamp(after.porcelain, 1500));
      if (!after.diffstat && !after.porcelain) lines.push("(working tree clean — no files were changed)");
    }
  }

  if (planMode) {
    lines.push("");
    lines.push("plan mode: agy blocked all workspace edits; any file it 'wrote' went to its own scratch dir.");
    lines.push("Shell commands still executed. Nothing in the repo changed.");
  }

  lines.push("");
  lines.push("--- response ---");
  lines.push(clamp(response.trim() || "(empty response)", CFG.maxChars));

  if (plan?.missing) {
    lines.push("");
    lines.push(`plan artifact: ${plan.diagnostic}`);
  } else if (plan) {
    lines.push("");
    lines.push(`--- implementation plan (${plan.path}) ---`);
    lines.push(clamp(plan.body.trim(), CFG.maxChars));
  }
  if (transcript) {
    lines.push("");
    lines.push(`full transcript: ${transcript}`);
  }
  if (res.stderr.trim() && res.code !== 0) {
    lines.push("");
    lines.push(`stderr: ${clamp(res.stderr.trim(), 800)}`);
  }

  return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// tool: command  (agy slash commands)
// ---------------------------------------------------------------------------

/**
 * Hints only — the authoritative list comes from `help`. Antigravity documents
 * /plan, /boost, /goal, /teamwork-preview, /grill-me, /learn, /schedule,
 * /browser and /btw as interactive-TUI features; read-only informational
 * commands are the ones known to answer in print mode.
 */
const PRINT_SAFE_COMMANDS = ["/help", "/usage", "/quota", "/credits", "/permissions", "/hooks", "/changelog", "/model", "/config", "/mcp"];
const TUI_ORIENTED_COMMANDS = ["/plan", "/boost", "/goal", "/teamwork-preview", "/grill-me", "/learn", "/schedule", "/browser", "/btw"];

async function toolCommand(args) {
  let command = String(args.command ?? "").trim();
  if (!command) return err("`command` is required, e.g. \"/plan\" or \"/usage\".");
  if (!command.startsWith("/")) command = "/" + command;

  const input = String(args.input ?? "").trim();
  const prompt = input ? `${command} ${input}` : command;

  const cwd = normalizePath(String(args.cwd || defaultCwd()));
  const write = args.write === true;
  if (write) {
    const check = rootCheck(cwd);
    if (!check.ok) {
      return err(
        check.reason === "unset"
          ? "write=true requires AGY_ALLOWED_ROOTS to be set on the bridge."
          : `Refusing write access in ${cwd} — not inside AGY_ALLOWED_ROOTS (${CFG.allowedRoots.join(", ")}).`
      );
    }
  }

  const timeoutSec = toInt(args.timeout_seconds, 300);
  const outputFormat = ["text", "json", "stream-json"].includes(args.output_format)
    ? args.output_format
    : "text";

  const agyArgs = ["-p", prompt, "--output-format", outputFormat, "--print-timeout", `${timeoutSec}s`];
  if (args.model) agyArgs.push("--model", String(args.model));
  else if (!PRINT_SAFE_COMMANDS.includes(command)) agyArgs.push("--model", CFG.defaultModel);
  if (args.effort) agyArgs.push("--effort", String(args.effort));
  if (args.agent) agyArgs.push("--agent", String(args.agent));
  if (args.conversation_id) agyArgs.push("--conversation", String(args.conversation_id));
  if (write) agyArgs.push("--dangerously-skip-permissions");
  if (Array.isArray(args.extra_args)) agyArgs.push(...args.extra_args.map(String));

  const res = await runAgy(agyArgs, { cwd, timeoutMs: (timeoutSec + 30) * 1000 });

  const header = [`$ agy ${agyArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`, `cwd: ${cwd}`];
  const body = (res.stdout.trim() || "") + (res.stderr.trim() ? `\n[stderr]\n${res.stderr.trim()}` : "");

  if (res.timedOut) {
    return err([...header, "", `TIMED OUT after ${timeoutSec}s.`, clamp(body, 2000)].join("\n"));
  }

  const looksRefused =
    res.code !== 0 &&
    /interactive|not (supported|available) in (print|headless)|tui|unknown command/i.test(body);

  if (looksRefused && TUI_ORIENTED_COMMANDS.includes(command)) {
    return err(
      [
        ...header,
        "",
        `exit ${res.code} — agy refused this command in print mode.`,
        clamp(body, 2000),
        "",
        `${command} is documented as an interactive-TUI feature. Options: express the same intent as a ` +
          `plain 'delegate' brief (e.g. "research the codebase and produce an implementation plan, write it ` +
          `to PLAN.md, change nothing else"), or run the 'help' tool to see whether this agy version added ` +
          `a headless path for it.`,
      ].join("\n")
    );
  }

  if (res.code !== 0 && !res.stdout.trim()) {
    return err([...header, "", `exit ${res.code}`, clamp(body, 3000) || "(no output)"].join("\n"));
  }

  return ok([...header, "", clamp(body || "(no output)", CFG.maxChars)].join("\n"));
}

// ---------------------------------------------------------------------------
// tool: raw
// ---------------------------------------------------------------------------

async function toolRaw(args) {
  const argv = Array.isArray(args.args) ? args.args.map(String) : null;
  if (!argv || argv.length === 0) {
    return err("`args` is required: an array of arguments passed verbatim to agy, e.g. [\"mcp\",\"list\"].");
  }

  const sub = (argv.find((a) => !a.startsWith("-")) || "").toLowerCase();
  if (CFG.rawDeny.includes(sub)) {
    return err(
      `Refusing to run \`agy ${sub}\` — it is on the bridge's deny list (AGY_RAW_DENY=${CFG.rawDeny.join(",")}). ` +
        `Auth and self-update commands need a real terminal; run it yourself in a shell.`
    );
  }

  const cwd = normalizePath(String(args.cwd || defaultCwd()));
  if (args.cwd) {
    const check = rootCheck(cwd);
    const wantsWrite = argv.includes("--dangerously-skip-permissions");
    if (wantsWrite && !check.ok) {
      return err(
        `Refusing --dangerously-skip-permissions in ${cwd} — not inside AGY_ALLOWED_ROOTS ` +
          `(${CFG.allowedRoots.join(", ") || "unset"}).`
      );
    }
  }

  const timeoutSec = toInt(args.timeout_seconds, 300);
  const res = await runAgy(argv, {
    cwd,
    timeoutMs: (timeoutSec + 30) * 1000,
    stdin: args.stdin ? String(args.stdin) : undefined,
  });

  const out = [
    `$ agy ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
    `cwd: ${cwd} · exit ${res.timedOut ? `TIMEOUT(${timeoutSec}s)` : res.code}`,
    "",
    clamp(res.stdout.trim() || "(no stdout)", CFG.maxChars),
  ];
  if (res.stderr.trim()) out.push("", "[stderr]", clamp(res.stderr.trim(), 2000));
  return res.timedOut || (res.code !== 0 && !res.stdout.trim())
    ? err(out.join("\n"))
    : ok(out.join("\n"));
}

// ---------------------------------------------------------------------------
// tools: help / models / doctor
// ---------------------------------------------------------------------------

async function toolHelp(args) {
  const cwd = defaultCwd();
  const topic = args?.topic ? String(args.topic) : null;

  if (topic) {
    const argv = topic.startsWith("/")
      ? ["-p", topic.startsWith("/help") ? topic : `/help ${topic}`, "--output-format", "text"]
      : [topic, "--help"];
    const res = await runAgy(argv, { cwd, timeoutMs: 60000 });
    return ok(
      [`$ agy ${argv.join(" ")}`, "", clamp((res.stdout + res.stderr).trim() || "(no output)", CFG.maxChars)].join("\n")
    );
  }

  const [cliHelp, slashHelp] = await Promise.all([
    runAgy(["--help"], { cwd, timeoutMs: 60000 }),
    runAgy(["-p", "/help", "--output-format", "text"], { cwd, timeoutMs: 90000 }),
  ]);

  const sections = [
    "=== agy --help (flags and subcommands) ===",
    clamp((cliHelp.stdout + cliHelp.stderr).trim() || `(exit ${cliHelp.code}, no output)`, 6000),
    "",
    "=== agy -p /help (slash commands available in print mode) ===",
    clamp((slashHelp.stdout + slashHelp.stderr).trim() || `(exit ${slashHelp.code}, no output)`, 6000),
    "",
    "Note: /plan, /boost, /goal, /teamwork-preview, /grill-me, /learn, /schedule, /browser and /btw are " +
      "documented as interactive-TUI features. Try them via the 'command' tool — if this version refuses " +
      "them in print mode, express the intent as a 'delegate' brief instead.",
  ];
  return ok(sections.join("\n"));
}

async function toolModels() {
  const res = await runAgy(["models"], { cwd: defaultCwd(), timeoutMs: 60000 });
  if (res.code !== 0) {
    return err(`\`agy models\` exited ${res.code}.\n${res.stderr || res.stdout || "(no output)"}`);
  }
  return ok(res.stdout.trim() || "(no output)");
}

/** Read agy's settings.json on whichever machine agy actually runs. */
async function readAgySettings() {
  const rel = ".gemini/antigravity-cli/settings.json";
  if (USE_WSL) {
    const res = await run("sh", ["-c", `cat "$HOME/${rel}" 2>/dev/null`], {
      cwd: "/",
      timeoutMs: 20000,
    });
    if (res.code !== 0 || !res.stdout.trim()) return { path: `~/${rel}`, data: null };
    try {
      return { path: `~/${rel}`, data: JSON.parse(res.stdout) };
    } catch {
      return { path: `~/${rel}`, data: null, unparsable: true };
    }
  }
  const file = path.join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  try {
    return { path: file, data: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    return { path: file, data: null, unparsable: e?.code !== "ENOENT" };
  }
}

async function toolDoctor() {
  const cwd = defaultCwd();
  const ver = await runAgy(["--version"], { cwd, timeoutMs: 30000 });
  const models = ver.code === 0 ? await runAgy(["models"], { cwd, timeoutMs: 60000 }) : null;

  const lines = [
    `bridge:        ${SERVER_NAME} ${SERVER_VERSION} (node ${process.version}, ${process.platform})`,
    `agy binary:    ${CFG.bin}`,
    `execution:     ${USE_WSL ? `via wsl.exe -d ${WSL_DISTRO}` : "direct"}`,
    `default model: ${CFG.defaultModel}`,
    `timeout:       ${CFG.timeoutSec}s`,
    `digest limit:  ${CFG.maxChars} chars`,
    `transcripts:   ${CFG.transcriptDir}`,
    `write roots:   ${CFG.allowedRoots.length ? CFG.allowedRoots.join(", ") : "(none — write delegation disabled)"}`,
    `raw tool:      ${CFG.rawDisabled ? "disabled" : `enabled (deny: ${CFG.rawDeny.join(",") || "none"})`}`,
    "",
  ];

  // --- billing path -------------------------------------------------------
  const leaked = METERED_AUTH_VARS.filter((k) => process.env[k]);
  const settings = await readAgySettings();
  const provider = settings.data?.modelProvider ?? settings.data?.provider;

  lines.push(
    `auth enforcement: ${CFG.forceOauth ? "on — metered API/Vertex credentials are stripped from every run" : "OFF (AGY_FORCE_OAUTH=0)"}`
  );
  if (leaked.length) {
    lines.push(
      `  ${CFG.forceOauth ? "stripped" : "PASSING THROUGH"}: ${leaked.join(", ")}`,
      CFG.forceOauth
        ? `  (present in this process's environment; agy never sees them)`
        : `  WARNING: these will route billing to a metered API key, not your Google plan.`
    );
  }
  lines.push(`agy settings:   ${settings.path}${settings.data ? "" : settings.unparsable ? " (unreadable)" : " (not present — fine, defaults apply)"}`);
  if (provider) {
    lines.push(`  modelProvider: ${provider}`);
    if (String(provider).toLowerCase() === "gemini") {
      lines.push(
        `  WARNING: modelProvider "gemini" is the API-key path. Remove it from settings.json so agy uses the`,
        `  account from \`agy login\` (your Google AI plan) instead of metered API quota.`
      );
    }
  } else if (settings.data) {
    lines.push(`  modelProvider: (unset — signed-in Google account is used)`);
  }
  lines.push("");

  if (ver.code === 0) {
    lines.push(`agy version:   ${ver.stdout.trim() || "(no output)"}`);
  } else {
    lines.push(
      `agy version:   FAILED (exit ${ver.code})`,
      `  ${(ver.stderr || "no stderr").trim().split(/\r?\n/)[0]}`,
      USE_WSL
        ? `  Check that \`wsl -d ${WSL_DISTRO} -- bash -lc 'agy --version'\` works from this machine.`
        : `  Check AGY_BIN, or set it to the absolute path of the binary (usually ~/.local/bin/agy).`
    );
  }

  if (models) {
    if (models.code === 0) {
      const out = models.stdout.trim();
      lines.push("", "available models:", out || "(none returned — you may not be signed in)");
      if (out && !out.includes(CFG.defaultModel)) {
        lines.push(
          "",
          `WARNING: default model ${CFG.defaultModel} is not in this list. Delegation will be silently ` +
            `substituted. Set AGY_DEFAULT_MODEL to a slug shown above.`
        );
      }
    } else {
      lines.push(
        "",
        `\`agy models\` FAILED (exit ${models.code}) — most likely not signed in.`,
        `Run \`agy login\`${USE_WSL ? ` inside WSL (${WSL_DISTRO})` : ""} and retry.`,
        (models.stderr || "").trim().slice(0, 500)
      );
    }
  }

  return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

const COMMON_MODEL_PROPS = {
  model: {
    type: "string",
    description: `Model slug. Default ${CFG.defaultModel}. Run 'models' for what this install offers.`,
  },
  effort: {
    type: "string",
    enum: ["low", "medium", "high"],
    description: "Reasoning effort. Only meaningful when the model slug does not already encode a level.",
  },
  agent: {
    type: "string",
    description: "Named agent to run as (agy --agent), if you have custom agents configured.",
  },
  conversation_id: {
    type: "string",
    description: "Resume a previous agy conversation by id instead of starting fresh.",
  },
  extra_args: {
    type: "array",
    items: { type: "string" },
    description: "Additional raw flags appended to the agy invocation, e.g. [\"--json-schema\",\"./schema.json\"].",
  },
};

const ALL_TOOLS = [
  {
    name: "delegate",
    title: "Delegate a task to Antigravity (Gemini)",
    description:
      "Hand a scoped, mechanical coding task to the Antigravity CLI running Gemini — writing test cases, " +
      "boilerplate, small refactors, docstrings, type annotations, repetitive edits. Gemini reads and edits " +
      "files in `cwd` itself; you get back a short digest plus the git diffstat, not the full output. " +
      "Give it a precise brief: which files, which framework/conventions, what done looks like. " +
      "Always review the resulting diff — delegated work is unverified.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The full brief for Gemini. Self-contained: it does not see this conversation. Name target files, " +
            "the test framework and conventions to follow, and the acceptance criteria.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute path to the repo or subdirectory to work in. Must be inside AGY_ALLOWED_ROOTS." +
            (USE_WSL ? " Use the WSL path (e.g. /home/you/code/repo)." : ""),
        },
        write: {
          type: "boolean",
          description:
            "true (default): Gemini may create and edit files in cwd. false: no permissions are granted, so " +
            "tool calls are auto-denied in headless mode — use mode='plan' instead for read-only work.",
          default: true,
        },
        mode: {
          type: "string",
          enum: ["accept-edits", "plan"],
          description:
            "agy --mode. 'plan' is the headless equivalent of /plan: agy blocks every workspace edit and " +
            "produces an implementation_plan.md artifact, which this tool reads back into the response. " +
            "Permissions are auto-approved in plan mode (otherwise the run is silently auto-denied), so " +
            "shell commands still run — the barrier is on file writes, not on execution. Omit for normal behavior.",
        },
        strict_permissions: {
          type: "boolean",
          description:
            "Plan mode only. true withholds permission auto-approval, which usually means the run is " +
            "auto-denied and returns nothing. Default false.",
          default: false,
        },
        add_dir: {
          type: "array",
          items: { type: "string" },
          description: "Extra directories to add to agy's workspace (--add-dir), for cross-repo context.",
        },
        timeout_seconds: {
          type: "integer",
          description: `Hard timeout for this run. Default ${CFG.timeoutSec}.`,
          minimum: 30,
          maximum: 3600,
        },
        sandbox: {
          type: "boolean",
          description:
            "Run agy with --sandbox (restricts terminal execution). Off by default; note it can prevent " +
            "Gemini from executing the tests it writes.",
          default: false,
        },
        ...COMMON_MODEL_PROPS,
      },
      required: ["task", "cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "command",
    title: "Run an agy slash command",
    description:
      "Invoke an Antigravity slash command in headless print mode — /usage, /permissions, /mcp, /model, " +
      "/changelog and other read-only ones answer reliably. /plan, /boost, /goal, /teamwork-preview, " +
      "/grill-me, /learn, /schedule, /browser and /btw are documented as interactive-TUI features: try them, " +
      "but expect some to be refused outside the TUI, in which case the tool says so and suggests a fallback. " +
      "Run 'help' to see what this exact agy version exposes.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The slash command, with or without the leading slash, e.g. \"/plan\" or \"usage\".",
        },
        input: {
          type: "string",
          description: "Everything after the command — the instruction, cron expression, topic, etc.",
        },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to the first allowed root.",
        },
        write: {
          type: "boolean",
          description:
            "Allow file writes for this command (adds --dangerously-skip-permissions). Requires cwd inside " +
            "AGY_ALLOWED_ROOTS. Default false — most slash commands are informational.",
          default: false,
        },
        output_format: {
          type: "string",
          enum: ["text", "json", "stream-json"],
          description: "agy --output-format. Default text, which is what slash commands print.",
        },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 3600, description: "Default 300." },
        ...COMMON_MODEL_PROPS,
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "help",
    title: "Discover agy flags and slash commands",
    description:
      "Return `agy --help` and the slash-command list from this install, so you can use flags and commands " +
      "this bridge does not model explicitly. Call it before guessing at syntax. Pass `topic` for a " +
      "subcommand's help (e.g. \"mcp\") or a slash command (e.g. \"/plan\").",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Optional. A subcommand name for `agy <topic> --help`, or a /slash-command.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raw",
    title: "Run agy with arbitrary arguments",
    description:
      "Escape hatch: run the agy binary with an argv array you control, for any flag or subcommand this " +
      "bridge does not wrap (`mcp add`, `--json-schema`, `--input-format stream-json`, config subcommands, …). " +
      "Auth and self-update subcommands are refused. Adding --dangerously-skip-permissions is only allowed " +
      "inside AGY_ALLOWED_ROOTS. Check syntax with 'help' first.",
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments passed verbatim to agy, e.g. [\"mcp\",\"list\"] or [\"-p\",\"hi\",\"--output-format\",\"json\"].",
        },
        cwd: { type: "string", description: "Working directory. Defaults to the first allowed root." },
        stdin: { type: "string", description: "Optional text piped to agy's stdin (for --input-format stream-json)." },
        timeout_seconds: { type: "integer", minimum: 10, maximum: 3600, description: "Default 300." },
      },
      required: ["args"],
      additionalProperties: false,
    },
  },
  {
    name: "models",
    title: "List Antigravity model slugs",
    description: "Run `agy models` and return the slugs this install can actually reach.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doctor",
    title: "Check the agy bridge",
    description:
      "Verify the agy binary is reachable, report its version and the bridge's effective configuration " +
      "(allowed write roots, default model, WSL mode). Run this first when delegation fails.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const TOOLS = ALL_TOOLS.filter((t) => !(CFG.rawDisabled && t.name === "raw"));

const HANDLERS = {
  delegate: toolDelegate,
  command: toolCommand,
  help: toolHelp,
  raw: toolRaw,
  models: toolModels,
  doctor: toolDoctor,
};

// ---------------------------------------------------------------------------
// JSON-RPC / MCP plumbing
// ---------------------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Delegate mechanical coding work (test cases, boilerplate, small refactors) to Gemini via " +
          "`delegate`. Briefs must be self-contained — the delegate does not see this conversation. " +
          "Use `command` for agy slash commands, `raw` for any other flag, and `help` to discover what " +
          "this agy version supports. Always review the returned diff before trusting the work.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    case "tools/call": {
      const name = params?.name;
      const fn = HANDLERS[name];
      if (!fn || (CFG.rawDisabled && name === "raw")) {
        replyError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      try {
        reply(id, await fn(params?.arguments ?? {}));
      } catch (e) {
        reply(id, err(`${name} failed: ${e?.stack || e?.message || String(e)}`));
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg?.id !== undefined && msg?.id !== null) {
        replyError(msg.id, -32603, `Internal error: ${e?.message || String(e)}`);
      }
    });
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
