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

- `flow/`: the main A/B flow. 29 cases across 6 categories (`cases/`): tutoring (multi-turn, scripted wrong answers), coding (real workspaces, hidden tests), general, travel, 3D printing, brainstorming. Several cases contain words that trip Prism's router ("cron jobs", "spike", "status", "refactor", "war room", "what if"), so misrouting costs show up.
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

- Node 20+, git, and the `claude` CLI on PATH (or `CLAUDE_BIN` pointing at `claude.exe` or `cli.js`)
- `python` on PATH (Prism's hooks call `python`, not `python3`; the Microsoft Store alias doesn't count) and `bash` (Git Bash on Windows)
- The toggle branch fetched: `git fetch origin feature/enable-disable`
- **Credentials.** The fresh home can't see your normal Claude login, so set one of these:
  - `ANTHROPIC_API_KEY`: used by the runs and **required by the judge**. Billed to that API key.
  - `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`): runs bill to your Claude subscription instead. The judge still needs `ANTHROPIC_API_KEY`.

## Running it

From the repo root, on the branch that contains `evals/`:

```powershell
cd evals
npm install
node test/selftest.mjs        # free: case files, hidden tests vs reference solutions, blinding
node preflight.mjs            # free: builds every arm and checks it is what it claims
```

Preflight should end "Preflight clean." It prints, per arm, whether the CLAUDE.md block is there, what each hook prints for a sample prompt, how many bytes of markdown sit in `~/.claude/rules` (auto-loaded) and, for the toggle arms, `prism-forge status` and `claude plugin validate` on the mod.

**Approve the harness.** The runner refuses to start until you record a hash of the harness files (runner, `lib/`, cases). Review them, then pass `--approve-harness` once on your first run. That approval is yours to give. Any later change to those files makes the runner stop and ask again.

### 1. Pilot (do this first, then look before spending more)

```powershell
$env:EVAL_ONLY = "gen-percent,code-cron-month-end,tutor-bayes-base-rate,travel-japan-5day,print-pla-hot-car,brain-war-room-mobile-web"
node run-eval.mjs --flow flow --variant baseline --model claude-sonnet-5-5 --approve-harness
node run-eval.mjs --flow flow --variant v1 --model claude-sonnet-5-5
node run-eval.mjs --flow flow --variant v3 --model claude-sonnet-5-5
node summarize.mjs --flow flow
node build-report-lite.mjs flow
```

(bash: `EVAL_ONLY=... node run-eval.mjs ...`.) Then:

- Open `flow/summary.md` and `flow/report.html`, and read a few traces in `flow/<variant>/traces/`. Each row's `explanation` in `results.jsonl` holds the judge's reasoning per criterion. **Would you have graded any of them differently?** If so, fix the rubric in `cases/*.json` before the full run.
- Check "Did each arm behave like itself?" in the summary. If v1/v3 show persona tags on few turns, Prism isn't reaching the model, and the debug-log excerpt at the end of a trace shows why.
- Measure cost from the pilot: `summary.md` reports measured spend. Full run ≈ (pilot spend ÷ pilot sessions) × 29 cases × reps × arms. Use measured numbers, not guesses.

### 2. Full run

Baseline first, because the other variants are judged against its frozen outputs in `flow/baseline/ref/`. Clear `EVAL_ONLY` first (`Remove-Item Env:EVAL_ONLY`).

```powershell
node run-eval.mjs --flow flow --variant baseline --model claude-sonnet-5-5 --reps 2
node run-eval.mjs --flow flow --variant v1 --model claude-sonnet-5-5 --reps 2
node run-eval.mjs --flow flow --variant v2 --model claude-sonnet-5-5 --reps 2
node run-eval.mjs --flow flow --variant v3 --model claude-sonnet-5-5 --reps 2
node run-eval.mjs --flow flow --variant v4 --model claude-sonnet-5-5 --reps 2
node summarize.mjs --flow flow
node build-report-lite.mjs flow
```

Runs resume: re-running a variant skips (case, rep) pairs already in `results.jsonl`. Failed attempts go to `errors.jsonl` with a failure class and are retried on the next run. Useful flags: `--concurrency N` (default 4), `--timeout-s N` per session (default 1800). Set `EVAL_KEEP=1` to keep the temp home and workspace folders for inspection.

### 3. Toggle flow (Windows)

```powershell
node run-eval.mjs --flow flow-toggle --variant baseline --model claude-sonnet-5-5 --reps 3 --approve-harness
node summarize.mjs --flow flow-toggle
```

Read the per-check pass rates. `on_before` failing means Prism wasn't producing persona tags even while on, so the off checks prove nothing. A `toggle_not_applied` error means `/prism off` sent through `claude -p` streaming input never reached the mod's command (or the mod couldn't run the CLI). That's a finding about headless use of the mod, not about the model.

## Running it with Claude Code on your PC

Open your clone in Claude Code (Claude Desktop or the terminal), check out this branch, and ask:

> Follow evals/README.md: run selftest and preflight, fix anything preflight flags in my environment (don't change the harness), then run the pilot and show me summary.md and a few graded examples before doing anything else.

The harness approval and the go-ahead for the full run should come from you.

## Limits worth knowing before trusting a number

- **Synthesized prompts.** The cases were written for this eval, not taken from your history. Adding 5–10 of your real prompts (same JSON shape) makes the result more about your work.
- **Noise floor.** 29 cases × 2 reps can resolve differences of roughly 10–15 points on a 0–1 scale. Smaller effects will show CIs that include 0. That means "not detectable here", not "no effect".
- **Clean-room setup.** Arms run without your own CLAUDE.md, settings, MCP servers or plugins. That isolates Prism's effect, but it is not your exact daily setup.
- **Web tools are off** (`WebSearch`, `WebFetch` disallowed) in every arm, so travel answers rely on model knowledge. This keeps the arms comparable.
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
