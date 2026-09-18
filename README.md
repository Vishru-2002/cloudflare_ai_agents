# AI Debugging Agent — on Cloudflare, on the free plan

An AI agent that helps you find the root cause of a bug. You attach the source
and the error output; it investigates the code with analysis tools, explains what
it found, and — if you ask it to — drafts a patch that it will not apply until
you approve it.

Everything runs on Cloudflare's **Free** plan. No paid bindings, no paid models,
no second host for the backend.

```
React SPA ──► Cloudflare Worker (Hono) ──► Durable Object   (session memory, SQLite)
                     │                 ──► Workflow         (durable pipeline + approval gate)
                     │                 ──► Workers AI       (Llama 3.3 70B / GPT-OSS 20B)
                     └─────────────────►  D1                (Neuron ledger + run history)
```

The React app is built into `dist/client` and served by the same Worker, so there
is one deploy, one origin and no CORS.

---

## What it actually does

**Chat** — you ask a question. The agent runs a tool-calling loop, choosing from
six read-only analysis tools, then answers with `path:line` citations. Tool calls
stream to the UI as they happen, so you can see what it looked at.

| Tool | What it does |
| --- | --- |
| `list_files` | Inventory of the attached source |
| `read_file` | A numbered slice of a file |
| `analyze_code` | Static bug-pattern analysis (off-by-one loops, unawaited promises, mutable default args, …) |
| `parse_stack_trace` | JS / Python / Java traces → structured frames + the deepest non-vendor frame |
| `find_symbol` | Definitions and references for a symbol |
| `search_code` | Literal search with line numbers |

Nothing executes your code. Every tool is static text analysis, which is what
makes it safe to run untrusted source through a Worker.

**Analyze & Fix** — runs a Cloudflare Workflow:

1. `load-context` — read the session's files out of Durable Object storage
2. `static-analysis` — deterministic, costs zero Neurons
3. `hypothesize` — model ranks up to 3 root causes as JSON
4. `draft-patch` — model returns corrected file content; **we** compute the diff
5. `await-approval` — `step.waitForEvent`, up to 1 hour, nothing written yet
6. `apply-patch` — only on approval
7. `record` — write the run to D1, post a summary into the chat

Step 5 is the human-in-the-loop gate: the pipeline parks on Cloudflare's side
without holding a request open or burning a concurrency slot.

---

## Why each Cloudflare piece is here

**Durable Objects** hold one session's conversation and files in their own SQLite
storage. A chat turn therefore does zero D1 reads, and the state lives in the same
thread as the agent that uses it. SQLite-backed classes are the variant available
on the free plan, hence `new_sqlite_classes` in the migration.

**Workflows** exist for the approval gate and for checkpointing. Each `step.do`
result is persisted, so if `draft-patch` fails and retries, the `hypothesize` call
does **not** re-run — it replays from storage. On a 10,000 Neuron/day budget that
is the difference between a retry costing nothing and costing a third of the day's
allowance.

**D1** holds the one thing that must be shared across sessions: the daily Neuron
ledger. A per-session counter would let ten browser tabs blow through the free
allowance independently.

---

## Living inside the free tier

Cloudflare includes **10,000 Neurons per day** on the Free plan. This app treats
that as a hard design constraint rather than a footnote:

- Workers AI reports the true cost of each call in `usage.neurons`, and that is
  what the ledger records. The price table is only a fallback for responses that
  omit it, so the meter shows real spend rather than an estimate.
- The meter in the header shows spend against the budget, live.
- The app stops at **9,000** Neurons (`DAILY_NEURON_BUDGET`) so a demo never
  hard-fails mid-request. Resets 00:00 UTC.
- Tool results are capped at 2,000 characters. Results are re-sent to the model on
  every subsequent iteration, so an uncapped result is paid for again on each one —
  this single constant moves turns-per-day by several times.
- The tool loop is capped (`MAX_TOOL_ITERATIONS`), and the final iteration drops
  the tool definitions so the model must answer rather than spend another call.
- Step 2 of the Workflow is deterministic analysis — free evidence that makes the
  paid model calls shorter.

### Model choice

Only models that work without a billing method are offered. Cloudflare gates some
large models (DeepSeek v4, GLM 5.x, Kimi K2) behind paid billing; those are
deliberately absent.

| Model | Tools | In / Out Neurons per 1M tok | Use |
| --- | --- | --- | --- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | yes | 26,668 / 204,805 | Default. Best reasoning. |
| `@cf/openai/gpt-oss-20b` | yes | 18,182 / 27,273 | ~7x cheaper output — best value. |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | no | 13,778 / 26,128 | Cheap non-tool steps. |

Measured on Llama 3.3 70B with the bundled samples: a chat turn that makes one
tool call costs **~145 Neurons**, and a full seven-step Analyze & Fix run costs
**~115 Neurons**. That is roughly **60 chat turns or 75 analyses per day** inside
the free allowance — comfortably more than a demo needs. GPT-OSS 20B is several
times cheaper again; switch with the dropdown next to the message box.

Cloudflare's dashboard remains the billing source of truth.

### Free-plan limits this app stays inside

| Service | Free limit |
| --- | --- |
| Workers requests | 100,000 / day |
| Workers AI | 10,000 Neurons / day |
| Workflows | 100,000 instances / day, 1,024 steps, 3-day retention |
| Durable Objects | SQLite-backed classes only |
| D1 | included, with daily read/write limits |

---

## Getting started

Requires Node 18+ and a free Cloudflare account.

```bash
npm install
npx wrangler login                          # opens a browser; authorises Wrangler
npx wrangler d1 create ai-debug-agent-db    # prints a database id
```

Paste that id into `wrangler.jsonc` under `d1_databases[0].database_id`, then
create the tables:

```bash
npm run db:init          # local database
npm run db:init:remote   # same schema on Cloudflare
```

### Giving the agent access to Workers AI

Workers AI is real GPU inference; there is no local emulator. Everything else —
Worker, Durable Objects, D1, Workflows — runs fully locally. Pick one of:

**Local, with an API token (no workers.dev subdomain needed).** Create a token
at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
→ Custom token → Account → **Workers AI → Read**. Then:

```bash
cp .dev.vars.example .dev.vars   # fill in CF_ACCOUNT_ID and CF_AI_TOKEN
npm run dev                      # http://localhost:5173
```

The app calls the Workers AI REST API directly. `.dev.vars` is gitignored.

Click a sample bug in the left panel to try it without finding your own.


### Deploy

```bash
npm run deploy
```

Prints a `*.workers.dev` URL. That's the whole app — SPA, API, agent and all.

### Other commands

```bash
npm run typecheck  # all three project references
npm run build      # production build of the SPA + Worker
npm run preview    # serve the production build locally
npm run cf-typegen # regenerate types after changing bindings
npm run tail       # live production logs
```

---

## Layout

This project follows the structure of Cloudflare's official **React + Vite
Workers template**, which you can scaffold with:

```bash
npm create cloudflare@latest -- my-react-app --framework=react
```

Docs: <https://developers.cloudflare.com/workers/framework-guides/web-apps/react/>

That means `worker/` for the backend, `src/` for the SPA, `index.html` and
`vite.config.ts` at the root, and `@cloudflare/vite-plugin` running both together
under a single `npm run dev`. The Durable Object, Workflow, D1 and Workers AI
pieces are additions on top of that baseline.

```
index.html            SPA entry
vite.config.ts        React + cloudflare() plugin
wrangler.jsonc        bindings; main -> worker/index.ts

worker/
  index.ts            Hono router; serves the API, exports the DO and Workflow
  session.ts          DebugSession Durable Object — memory + the chat SSE stream
  workflow.ts         DebugWorkflow — the 7-step pipeline with the approval gate
  ai/
    agent.ts          the tool-calling investigate-then-answer loop
    client.ts         Workers AI wrapper: tool-call normalising, Neuron accounting
    models.ts         allowed models + Neuron price table
    prompts.ts        system prompts
  tools/
    index.ts          tool registry, schemas, dispatch
    static.ts         heuristic bug-pattern rules
    stacktrace.ts     JS / Python / Java trace parser
    diff.ts           unified-diff generator
  lib/budget.ts       the daily Neuron ledger

src/                  React SPA — App, api client, components, samples
shared/protocol.ts    wire types, imported by both sides as @shared/protocol
schema.sql            D1 tables: Neuron ledger + analysis history
```

TypeScript uses project references — `tsconfig.app.json` (SPA),
`tsconfig.worker.json` (Worker) and `tsconfig.node.json` (Vite config) — because
the SPA needs DOM types and the Worker needs `@cloudflare/workers-types`, and
mixing them hides real errors.

---

## Notes and limitations

- The agent reads code statically. It never runs it, and the system prompt tells
  it not to claim otherwise.
- Static-analysis findings are heuristics, presented to the model as hints to be
  confirmed against the source — not as facts.
- An approved patch is applied to the copy of the file held in the session, not to
  anything on your disk.
- Sessions are keyed by a UUID in `localStorage`. Anyone with the id can reach
  that session; there is no authentication. Add Cloudflare Access in front of it
  before putting real code through a shared deployment.
- Workflow instances age out after 3 days on the free plan, so an old analysis may
  report no status.
- The patch step asks the model for the whole corrected file. On a large file that
  is the most expensive call in the pipeline, and models occasionally return a
  cosmetically noisy diff (a stray trailing blank line, say). The diff is computed
  from the real before/after text, so what you approve is exactly what is applied.