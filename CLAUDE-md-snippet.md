<!-- Paste into a project CLAUDE.md, or ~/.claude/CLAUDE.md for every project. -->

## Delegating to Gemini via agy

The `agy` MCP server runs Google Antigravity against Gemini 3.8 Flash (High) on the
signed-in Google plan. Use it to keep mechanical work out of this context window.

**Delegate by default:**

- writing test cases against code that already exists and is settled
- boilerplate: fixtures, factories, mocks, `__init__` exports, config scaffolding
- mechanical edits across many files: renames, import rewrites, adding type
  annotations or docstrings, migrating a deprecated call
- translating a settled spec into a first implementation draft
- one-off scripts and data munging that live outside the product code

**Do not delegate:**

- anything where the question is *what* to build, not *how* — architecture, data
  modeling, API shape, tradeoffs the user cares about
- debugging that needs the history of this conversation
- security-sensitive code, auth flows, migrations that touch production data
- work in a repo with uncommitted changes you haven't accounted for
- final review. Gemini's output is a draft until you have read the diff

**How to call it:**

1. `cwd` is the repo root or the subdirectory the work belongs in, and must be inside
   the bridge's allowed roots.
2. The brief is self-contained — the delegate cannot see this conversation. Name the
   files, the test framework and its conventions in this repo, the fixtures available,
   and what "done" means. A brief shorter than three sentences is usually too vague.
3. Say explicitly what not to touch. "Add tests in `tests/test_billing.py` only; do not
   modify `billing.py`" prevents most of the bad outcomes.
4. Leave `write: true` (the default) so Gemini edits files itself — the point is to keep
   the output out of this context.

**After every delegation:**

- Read the diff. Not the summary, the diff.
- Run the tests yourself. A delegated test suite that passes on the first try deserves
  more suspicion, not less — check that the assertions are real and that the tests fail
  when the code is broken.
- If the digest says the model reported differs from the one requested, or wasn't
  reported at all, weigh the output accordingly.

**Other tools on the same server:** `command` runs agy slash commands (`/usage`,
`/plan`, …), `help` lists what this agy version supports, `raw` takes arbitrary argv,
`doctor` diagnoses the setup. Reach for `help` before guessing at syntax.
