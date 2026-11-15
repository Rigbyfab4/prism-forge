# Prism Forge A/B evals

Does Claude Code do better work with Prism Forge installed? These evals run the same prompts through Claude Code with and without Prism and grade the results blind.

## What gets compared

Each case runs in a **fresh, empty home folder** (`HOME`/`USERPROFILE` point at a temp dir), so no arm sees your real `~/.claude`. The arms differ only in what gets installed into that folder:

| Variant | Arm | What it is |
|---|---|---|
| `baseline` | `none` | Plain Claude Code. No Prism. |
| `v1` | `prism-main` | Prism from `main`, installed with `prism-forge install` as shipped. |
| `v2` | `prism-main-hookfix` | Same as v1, plus one fix: the UserPromptSubmit hook emits `hookSpecificOutput.additionalContext` (the documented shape) instead of a top-level `additionalContext`. v1 vs v2 shows whether the per-message routing directive reaches the model at all. |
| `v3` | `prism-toggle-on` | Prism from `origin/feature/enable-disable` (installs to `~/.claude/prism`, adds `disable`/`enable`/`status`), with the **prism-toggle mod** loaded via `--plugin-dir`. Enabled. |
| `v4` | `prism-toggle-off` | Same as v3, then `prism-forge disable`. If "off" really means off, v4 should be indistinguishable from baseline. |

The mapping lives in `flow/_state.json` (`arms`, `refs`). Change `refs` to test other commits.

**Two flows:**

- `flow/`: the main A/B flow. 32 cases across 7 categories (`cases/`): tutoring (multi-turn, scripted wrong answers), coding (real workspaces, hidden tests), general, travel, 3D printing, brainstorming, and research. Three cases (`cases/real-prompts.json`, tagged `source:user-history`) are your own prompts from past sessions: the VAR question, Oregon Trail Tay, and the Witch Walker check (its first turn lightly adapted; see the case's `notes`). Several cases contain words that trip Prism's router ("cron jobs", "spike", "status", "refactor", "war room", "what if"), so misrouting costs show up.
- `flow-toggle/`: mid-session switching on the toggle branch (`cases-toggle/`). It sends `/prism off` and `/prism on` through the mod and checks that persona tags stop and restart. One case toggles with the CLI only (no mod), which isolates what the mod's "PRISM was just turned off" notice adds. After each toggle the harness confirms with `prism-forge status` that the switch happened. If it didn't, the attempt is logged as `toggle_not_applied` and not scored.

## How it's graded

Per case, as applicable:

- **`checks`**: deterministic. For coding: hidden tests copied in only after the session ends, plus a no-op detector for the refactor case. Otherwise: a correct number present, word limits, bullet counts, no unrequested sitrep.
- **`rubric`**: an LLM judge (default `claude-opus-5-5`, set `judge_model` in `_state.json`) marks each of 3–6 concrete criteria met or missed. Score = fraction met.
- **`win`**: blind pairwise judgment against the frozen baseline output, run in **both orders** to cancel position bias. 1 = this arm preferred both times, 0.5 = tie or split, 0 = baseline preferred both times.

Before judging, Prism's `**Name (Role):**` labels and roster lines are stripped from both sides, so the judge can't tell which arm wrote what from formatting. Persona voice can still show through the prose, so treat `win` as a judgment of substance with that caveat.

Also recorded per session: cost (from token usage × list price), Claude Code's own reported cost, **start context** (input tokens of the first request, which is where Prism's injected instructions show up), output tokens, latency, words, tool calls, share of turns with persona tags, and whether turn 1 was a sitrep. Each trace ends with an excerpt of Claude Code's debug log (hook and plugin lines).

## Requirements

Windows is needed for the toggle arms and flow: the mod hard-codes Windows paths. Everything else runs on macOS/Linux too.

- Node 20.6+ (for `--env-file`), git, and the `claude` CLI on PATH (or `CLAUDE_BIN` pointing at `claude.exe` or `cli.js`)
- `python` on PATH (Prism's hooks call `python`, not `python3`; the Microsoft Store alias doesn't count) and `bash` (Git Bash on Windows)
- The toggle branch fetched: `git fetch origin feature/enable-disable`
- **Credentials, in `evals/.env`** (gitignored; copy `.env.example`). Each run uses a fresh empty home that can't see your normal Claude login, and setting keys globally would also switch your everyday Claude Code to API billing, so the scripts read this file via `node --env-file=.env`:
  - `ANTHROPIC_API_KEY`: **required by the judge**. If it's the only credential, the Claude Code runs bill to it too.
  - `CLAUDE_CODE_OAUTH_TOKEN` (optional; create it with `claude setup-token` in a normal terminal): the Claude Code runs bill to your subscription instead, and the API key is withheld from them. Subscriptions have usage limits, so use `--concurrency 2` if you go this way.

## Running it

Commands below are PowerShell, run from `evals/`. In Git Bash (and in a Claude Code session's shell) write `EVAL_ONLY=a,b node ...` instead of `$env:EVAL_ONLY = "a,b"`.

### 0. Setup and free checks

```powershell
git fetch origin
git checkout claude/friendly-bohr-txjn97
git fetch origin feature/enable-disable
cd evals
npm install
Copy-Item .env.example .env    # then open .env and fill it in
node test/selftest.mjs                       # case files, hidden tests vs reference solutions, blinding
node --env-file=.env preflight.mjs           # builds every arm and checks it is what it claims
```

Preflight should end "Preflight clean." It prints, per arm, whether the CLAUDE.md block is there, what each hook prints for a sample prompt, how many bytes of markdown sit in `~/.claude/rules` (auto-loaded) and, for the toggle arms, `prism-forge status` and `claude plugin validate` on the mod. **Stop here if it reports problems.** The usual ones are `python` resolving to the Microsoft Store alias, `bash` not on PATH (install Git for Windows), or an empty `.env`.

**Approve the harness.** The runner refuses to start until you record a hash of the harness files (runner, `lib/`, cases). Review them, then pass `--approve-harness` once on your first run. That approval is yours to give. Any later change to those files makes the runner stop and ask again.

### 1. Pilot: 6 cases on every arm, plus one toggle pass

This checks the wiring on real Claude Code before you spend on the full run. It's about 30 sessions plus judging.

```powershell
$env:EVAL_ONLY = "gen-percent,code-cron-month-end,tutor-bayes-base-rate,travel-japan-5day,print-pla-hot-car,brain-war-room-mobile-web"
node --env-file=.env run-eval.mjs --flow flow --variant baseline --model claude-sonnet-5-5 --approve-harness
node --env-file=.env run-eval.mjs --flow flow --variant v1 --model claude-sonnet-5-5
node --env-file=.env run-eval.mjs --flow flow --variant v2 --model claude-sonnet-5-5
node --env-file=.env run-eval.mjs --flow flow --variant v3 --model claude-sonnet-5-5
node --env-file=.env run-eval.mjs --flow flow --variant v4 --model claude-sonnet-5-5
Remove-Item Env:EVAL_ONLY
node --env-file=.env run-eval.mjs --flow flow-toggle --variant baseline --model claude-sonnet-5-5 --approve-harness
node summarize.mjs --flow flow
node summarize.mjs --flow flow-toggle
node build-report-lite.mjs flow
```

Then check, in this order:

1. **Errors.** `flow/<variant>/errors.jsonl` should be empty or nearly so. `claude_error` or `harness` usually means a setup problem (credentials, `claude` not found, streaming format). Fix it before anything else.
2. **Did each arm behave like itself?** (section in `flow/summary.md`.) v1/v3 should show persona tags on most turns, v4 on none. If v1 shows few tags, read the debug-log excerpt at the end of one of its traces in `flow/v1/traces/`. If v2 tags far more than v1, the hook-format problem is real.
3. **Start context.** Compare v1 and v3 with baseline. A v1 overhead in the tens of thousands of tokens means Claude Code loads the `~/.claude/rules` persona files.
4. **Toggle flow.** `toggle_not_applied` errors mean `/prism` doesn't reach the mod through headless `claude -p`. That's a finding, not a harness bug.
5. **The judge.** Read a few rows' `explanation` in `flow/v1/results.jsonl` beside their traces. **Would you have graded any of them differently?** If so, fix the rubric in `cases/*.json` before the full run. Editing cases changes the harness hash, so you'll approve again.
6. **Cost.** `summary.md` reports measured spend. Full run ≈ (pilot spend ÷ pilot sessions) × 32 cases × 2 reps × 5 arms, plus the toggle flow.

### 2. Full run

Baseline first, because the other variants are judged against its frozen outputs in `flow/baseline/ref/` (a variant run before baseline refuses to start). Pilot rows are reused: resume skips (case, rep) pairs already done.

```powershell
foreach ($v in "baseline","v1","v2","v3","v4") {
  node --env-file=.env run-eval.mjs --flow flow --variant $v --model claude-sonnet-5-5 --reps 2
}
node --env-file=.env run-eval.mjs --flow flow-toggle --variant baseline --model claude-sonnet-5-5 --reps 3
node summarize.mjs --flow flow
node summarize.mjs --flow flow-toggle
node build-report-lite.mjs flow
```

Failed attempts go to `errors.jsonl` with a failure class and are retried the next time you run the same command. Useful flags: `--concurrency N` (default 4), `--timeout-s N` per session (default 1800). Set `EVAL_KEEP=1` to keep the temp home and workspace folders for inspection.

Reading the toggle flow: `on_before` failing means Prism wasn't producing persona tags even while on, so the off checks prove nothing. Compare `toggle-off-via-mod` with `toggle-off-via-cli` to see what the mod's notice adds.

## Running it with Claude Code on your PC

Do step 0's `git` commands and fill in `.env` yourself, so your keys never go into a chat. Then open the repo folder in Claude Code (Claude Desktop's Code tab, or `claude` in a terminal) and paste:

> Read evals/README.md. Then, from evals/: run `npm install`, `node test/selftest.mjs` and `node --env-file=.env preflight.mjs`. If preflight reports problems in my environment (python, bash, claude, .env), explain each and how to fix it. Don't change anything under evals/ to work around them. Stop and show me the preflight output.
>
> When I say go: run the pilot from section 1 exactly as written. Its first command includes --approve-harness, which records my approval of the harness: show me that command and wait for my OK before running it. Run the pilot in the background and tell me when it finishes. Then walk me through checks 1–6 of section 1, showing me two graded examples with their transcripts and the measured cost. Don't start the full run until I approve it.

Claude Code will ask permission before running these commands. The eval's child sessions are separate `claude -p` processes, each in its own temp folder.

## Limits worth knowing before trusting a number

- **Mostly synthesized prompts.** 29 of 32 cases were written for this eval; 3 come from your history. Adding more of your real prompts (same JSON shape) makes the result more about your work. Most of your past cloud-session messages were follow-ups that only make sense mid-conversation; your local Claude Code history on your PC (`~/.claude/projects/`) is a richer source.
- **Noise floor.** 32 cases × 2 reps can resolve differences of roughly 10–15 points on a 0–1 scale. Smaller effects will show CIs that include 0. That means "not detectable here", not "no effect".
- **Clean-room setup.** Arms run without your own CLAUDE.md, settings, MCP servers or plugins. That isolates Prism's effect, but it is not your exact daily setup.
- **Web tools are off** (`WebSearch`, `WebFetch` disallowed) except in cases marked `"web": true` (the two research cases from your history). A case's setting is identical in every arm, so arms stay comparable, but web cases are noisier run to run. Travel answers rely on model knowledge.
- **Costs** use list prices with 5-minute cache-write pricing. Claude Code may use 1-hour cache writes, so `cost_usd` can read slightly low. Claude Code's own figure is shown beside it (`cc_cost_usd`).
- **The judge is a model.** Its order consistency is reported. Spot-check its reasoning in the pilot before relying on it.

## Files

| Path | What |
|---|---|
| `run-eval.mjs` | Runner, adapted from the claude-api skill's eval scaffold: resume, backoff, per-case ceiling, served-model check, error sidecar, harness gate |
| `lib/eval-case.mjs` | Loads cases, runs one case in its arm's isolated home, grades it |
| `lib/arms.mjs` | Arm definitions (what each variant installs) |
| `lib/claude.mjs` | Drives `claude -p` with stream-json in/out, one process per case |
| `lib/checks.mjs`, `lib/judge.mjs` | Deterministic checks, blinding, LLM judge (Anthropic SDK, structured outputs) |
| `cases/`, `cases-toggle/` | Case definitions |
| `fixtures/`, `hidden/`, `oracle/` | Coding workspaces, hidden tests, reference solutions (selftest only) |
| `preflight.mjs`, `summarize.mjs`, `build-report-lite.mjs` | Arm checks, statistics, HTML report |
| `test/` | Selftest and a fake `claude` used to test the plumbing for free (`CLAUDE_BIN=test/fake-claude.mjs EVAL_JUDGE=mock`) |
