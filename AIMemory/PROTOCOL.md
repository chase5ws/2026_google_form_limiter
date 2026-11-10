# AIMemory Protocol (compact)

Shared working memory for every AI agent on this project (Claude, Codex,
Gemini, Cursor, …). Compact edition of agent-work-mem v2 by
daystar7777 (MIT): https://github.com/daystar7777/agent-work-mem

If the `awm` MCP server is connected, use its tools — they apply these rules
for you and cost fewer tokens than reading files. Otherwise follow this file.

## 1. Read before working (every session / new request)
1. `AIMemory/INDEX.md` → 2. `AIMemory/PROJECT_OVERVIEW.md` →
3. last ~20 events of `AIMemory/work.log`.
If a `WORK_START` has no later `WORK_END` from the same model, ask the user
"resume or start fresh?" before doing anything.
Older history: grep the Topic index in INDEX.md, then open only the matching
`archive/` file. Never pre-load archives "just in case".

## 2. Log what you do (append-only)
Header: `### YYYY-MM-DD HH:MM | <model-id> | <EVENT>` then a free-form body.
- `PROMPT` — the user's message, verbatim, as a `> ` blockquote
- `WORK_START` — `Task: <one line>`
- `FILES_CREATED / FILES_MODIFIED / FILES_MOVED / FILES_DELETED` — paths
- `WORK_END` — `Status: complete | partial | blocked` + one line
- `NOTE` — assumptions, open questions for the next agent
- `RE_ENGAGED` / `PROJECT_BOOTSTRAPPED` — session start; one line each:
  Tier (A files+shell / B sandbox / C chat), Vendor, Harness, Capabilities
- `CORRECTION` — fix an earlier event (never edit in place)
Append each event in ONE write (`cat >> AIMemory/work.log <<'EOF'`), keep
it under 4 KB; put long material in `AIMemory/<slug>.<model-id>.md` and link.
Skip ceremony for trivial one-line requests. Don't log every read/grep.

## 3. Files
AI-authored notes live in `AIMemory/` as `<slug>.<model-id>.md`
(harness files like CLAUDE.md / AGENTS.md stay where the harness wants them).
Never write secrets (tokens, keys, passwords) into AIMemory.

## 4. Tiers
work.log keeps the newest `HOT_RETENTION_EVENTS` (INDEX.md). When it grows
past 1.5×, move older events to `archive/work-<date>.log`, add/refresh the
row in INDEX's Warm table, add 3–7 kebab-case topics to the Topic index, and
log a NOTE. Cold digests (`cold/digest-YYYY-MM.md`) only on user request.
PROJECT_OVERVIEW.md is a short derived primer: update it only for decisions
a new agent must know.

## 5. Handoffs (AICP)
To ask another AI to act, create `AIMemory/handoff_<slug>.<model-id>.md`:
header lines From / From-vendor / To / Date / Type (DECISION_RELAY,
REVIEW_REQUEST, REVIEW_RESPONSE, QUESTION, ANSWER, BLOCKER_RAISED,
STATUS_REPORT, PROPOSAL) / Priority (BLOCKING, HIGH, NORMAL, LOW) /
Reply by / Re / Required capability; sections Summary, Context, Content,
Action items (`- [ ]`), Waiting on. Log `FILES_CREATED` + `HANDOFF`, list it
under "Active handoffs" in INDEX.md. Receiver logs `HANDOFF_RECEIVED`, then
`HANDOFF_CLOSED` when done and removes it from the list. Amend with a new
`_v2` file instead of editing after it was received.
