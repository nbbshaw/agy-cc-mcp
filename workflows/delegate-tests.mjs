/**
 * delegate-tests — Claude decides what needs coverage, Gemini writes the tests,
 * Claude verifies them.
 *
 * Save to .claude/workflows/delegate-tests.mjs and run it with the Workflow tool
 * (name: "delegate-tests"), passing the repo root and an optional focus:
 *
 *   args = { repo: "/home/nik/code/myproject", focus: "the billing module" }
 *
 * Requires the agy MCP server registered at user scope so every spawned agent
 * inherits mcp__agy__* — see the bridge README.
 */

export const meta = {
  name: 'delegate-tests',
  description: 'Map untested modules, delegate test-writing to Gemini via agy, verify each suite in Claude',
  phases: [
    { title: 'Survey', detail: 'Find the modules most worth covering' },
    { title: 'Delegate', detail: 'Gemini writes each suite through mcp__agy__delegate' },
    { title: 'Verify', detail: 'Claude runs the tests and reads the diffs' },
  ],
}

const REPO = args?.repo
if (!REPO) throw new Error('args.repo is required: the absolute repo path (a Windows path is fine in WSL mode)')
const FOCUS = args?.focus ?? 'the whole repository'
const MAX_TARGETS = args?.max ?? 4

const SURVEY_SCHEMA = {
  type: 'object',
  properties: {
    framework: { type: 'string', description: 'Test framework and runner command, e.g. "pytest, run with `uv run pytest`"' },
    conventions: { type: 'string', description: 'How tests are laid out and named in this repo, fixtures available' },
    example_test_file: { type: 'string', description: 'Path to an existing test file worth imitating' },
    targets: {
      type: 'array',
      maxItems: MAX_TARGETS,
      items: {
        type: 'object',
        properties: {
          source_file: { type: 'string' },
          test_file: { type: 'string', description: 'Path the new tests should live at' },
          behaviors: { type: 'string', description: 'The specific behaviors and edge cases that need covering' },
        },
        required: ['source_file', 'test_file', 'behaviors'],
      },
    },
  },
  required: ['framework', 'conventions', 'targets'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    test_file: { type: 'string' },
    tests_pass: { type: 'boolean' },
    assertions_are_real: { type: 'boolean', description: 'False if tests pass trivially or assert nothing meaningful' },
    scope_respected: { type: 'boolean', description: 'False if files outside the brief were modified' },
    model_warning: { type: 'boolean', description: 'True if the delegate digest warned about model substitution' },
    notes: { type: 'string' },
  },
  required: ['test_file', 'tests_pass', 'assertions_are_real', 'scope_respected', 'notes'],
}

// --- Phase 1: survey -------------------------------------------------------

const survey = await agent(
  `Working in the repo at ${REPO}, focused on ${FOCUS}.

Identify up to ${MAX_TARGETS} source files whose behavior is settled, non-trivial, and currently
untested or badly under-tested. For each, name the exact path the new test file should live at and
the specific behaviors and edge cases that need covering — not "test the module", but the actual
cases someone would regret not having.

Also report: the test framework and the exact command that runs the suite, this repo's test layout
and naming conventions, available fixtures/helpers, and the path to one existing test file that is
a good model to imitate.

Read the code. Do not write or modify any files in this phase.`,
  { label: 'survey', phase: 'Survey', schema: SURVEY_SCHEMA },
)

if (!survey?.targets?.length) {
  return { skipped: true, reason: 'Survey found nothing worth covering', survey }
}

// --- Phases 2 & 3: delegate, then verify each suite as it lands -------------

const results = await pipeline(
  survey.targets,
  (t) =>
    agent(
      `Delegate test-writing to Gemini. Do NOT write the tests yourself.

Call mcp__agy__delegate with:
  cwd: "${REPO}"
  write: true
  task: a complete, self-contained brief. The delegate cannot see this workflow, so the brief must
  itself state:
    - Create tests at ${t.test_file} for ${t.source_file}.
    - Framework and runner: ${survey.framework}
    - Conventions to follow: ${survey.conventions}
    ${survey.example_test_file ? `- Imitate the style of ${survey.example_test_file}.` : ''}
    - Behaviors and edge cases to cover: ${t.behaviors}
    - Do not modify ${t.source_file} or any other production file. Do not commit. Do not touch
      files outside ${t.test_file}.
    - Each test must fail if the behavior it covers is broken.

Then report the delegate's digest verbatim, including the git diffstat and any model-substitution
warning it contained.`,
      { label: `delegate:${t.test_file}`, phase: 'Delegate' },
    ),
  (digest, t) =>
    agent(
      `Verify the tests just written at ${t.test_file} in ${REPO}.

The delegation digest was:
${typeof digest === 'string' ? digest : JSON.stringify(digest)}

Do this yourself — do not ask Gemini whether its work was good:
  1. Read the actual diff for ${t.test_file}.
  2. Run the suite: ${survey.framework}
  3. Judge whether the assertions are real. Break the covered behavior in a scratch copy, or reason
     concretely about whether each test could pass with the code broken.
  4. Check with git status that nothing outside ${t.test_file} was modified.
  5. Note whether the digest warned about model substitution.

Report honestly. A suite that passes but asserts nothing is a failure, not a success.`,
      { label: `verify:${t.test_file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ),
)

const verdicts = results.flat().filter(Boolean)
const good = verdicts.filter((v) => v.tests_pass && v.assertions_are_real && v.scope_respected)
const bad = verdicts.filter((v) => !good.includes(v))

return {
  repo: REPO,
  framework: survey.framework,
  delegated: survey.targets.length,
  accepted: good.map((v) => v.test_file),
  needs_attention: bad.map((v) => ({ file: v.test_file, notes: v.notes })),
  model_warnings: verdicts.filter((v) => v.model_warning).map((v) => v.test_file),
}
