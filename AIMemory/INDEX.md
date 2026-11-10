# AIMemory Index — 2026_google_form_limiter

## Configuration
- HOT_RETENTION_EVENTS: 20
- CONTEXT_TAIL_EVENTS: 15

## Hot — read every session
- work.log — recent events, append-only (auto-rotated to archive/)

## Warm — read only when needed (memory_search or the Topic index first)
| File | Date range | Events | Topics | Summary |
|------|------------|--------|--------|---------|
<!-- memory:warm:start -->
<!-- memory:warm:end -->

## Cold — fetch only on explicit need
| File | Period covered | Topics | Summary |
|------|----------------|--------|---------|

## Topic index — grep me
<!-- memory:topics:start -->
<!-- memory:topics:end -->

## Active handoffs (open AICP threads)
<!-- memory:handoffs:start -->
<!-- memory:handoffs:end -->

## Other notable files
- PROJECT_OVERVIEW.md — onboarding primer (read after this file)
- PROTOCOL.md — rules, for agents without the easy MCP server
- LESSONS.md — lessons learned on this project (lesson_add)

Last update: 2026-11-10 09:14
