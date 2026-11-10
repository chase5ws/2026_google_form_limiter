# AIMemory Protocol

Shared working memory for every AI agent on this project (Claude, Codex,
Gemini, Cursor, …). If the `easy` MCP server is connected, use its tools —
they apply these rules for you and cost fewer tokens than reading files.
Otherwise follow this file.

## 1. Read before working (every session / new request)
1. `AIMemory/INDEX.md` → 2. `AIMemory/PROJECT_OVERVIEW.md` →
3. `AIMemory/LESSONS.md` (if present) → 4. last ~20 events of `AIMemory/work.log`.
If a `WORK_START` has no later `WORK_END` from the same model, ask the user
"resume or start fresh?" before doing anything.
For older history grep the Topic index in INDEX.md and open only the matching
`archive/` file. Never pre-load archives "just in case".

## 2. Log what you do (append-only)
Header `### YYYY-MM-DD HH:MM | <model-id> | <EVENT>`, then a free-form body.

| Event | Body |
|---|---|
| `RE_ENGAGED` / `PROJECT_BOOTSTRAPPED` | session start, one line: Tier (A files+shell / B sandbox / C chat), Vendor, Harness, Capabilities |
| `PROMPT` | the user's message, verbatim, as a `> ` blockquote |
| `WORK_START` | `Task: <one line>` |
| `FILES_CREATED` / `FILES_MODIFIED` / `FILES_MOVED` / `FILES_DELETED` | paths |
| `NOTE` | assumptions, open questions for the next agent |
| `WORK_END` | `Status: complete \| partial \| blocked` + one line |
| `CORRECTION` | fixes an earlier event (never edit in place) |
| `HANDOFF` / `HANDOFF_RECEIVED` / `HANDOFF_CLOSED` | see § 5 |

Append each event in ONE write (`cat >> AIMemory/work.log <<'EOF'`) and keep
it under 4 KB; put long material in `AIMemory/<slug>.<model-id>.md` and link
it. Skip ceremony for trivial one-line requests; don't log reads or greps.

## 3. Files
AI-authored notes live in `AIMemory/` as `<slug>.<model-id>.md`. Harness files
(CLAUDE.md, AGENTS.md, .cursorrules) stay where the harness expects them.
Never write secrets (tokens, keys, passwords) into AIMemory.

## 4. Tiers
`work.log` keeps the newest `HOT_RETENTION_EVENTS` (set in INDEX.md). Past
1.5× that, move older events to `archive/work-<date>.log`, refresh its row in
INDEX's Warm table, add 3–7 kebab-case topics to the Topic index and log a
`NOTE`. Cold digests (`cold/digest-YYYY-MM.md`) are written only on request.
`PROJECT_OVERVIEW.md` is a short derived primer: change it only for things a
new agent must know.

## 5. Handoffs
To ask another AI to act, create `AIMemory/handoff_<slug>.<model-id>.md` with
header lines From / From-vendor / To / Date / Type (DECISION_RELAY,
REVIEW_REQUEST, REVIEW_RESPONSE, QUESTION, ANSWER, BLOCKER_RAISED,
STATUS_REPORT, PROPOSAL) / Priority (BLOCKING, HIGH, NORMAL, LOW) / Reply by /
Re / Required capability, and sections Summary, Context, Content, Action items
(`- [ ]`), Waiting on. Log `FILES_CREATED` + `HANDOFF` and list it under
"Active handoffs" in INDEX.md. The receiver logs `HANDOFF_RECEIVED`, then
`HANDOFF_CLOSED` and removes it from the list. After it was received, amend
with a new `_v2` file instead of editing.

## 6. Lessons
When the user corrects you or a mistake is found, append one line to
`AIMemory/LESSONS.md`: `- YYYY-MM-DD (<model-id>) <rule> — <why>`.
Read and follow these lessons at the start of every session.
