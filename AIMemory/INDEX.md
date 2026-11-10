# AIMemory Index — 2026_google_form_limiter

## Configuration
- HOT_RETENTION_EVENTS: 20
- CONTEXT_TAIL_EVENTS: 15

## Hot — read every session
- work.log — recent events, append-only (auto-rotated to archive/)

## Warm — read only when needed (awm_search or the topic index first)
| File | Date range | Events | Topics | Summary |
|------|------------|--------|--------|---------|
<!-- awm:warm:start -->
<!-- awm:warm:end -->

## Cold — fetch only on explicit need
| File | Period covered | Topics | Summary |
|------|----------------|--------|---------|

## Topic index — grep me
<!-- awm:topics:start -->
<!-- awm:topics:end -->

## Active handoffs (open AICP threads)
<!-- awm:handoffs:start -->
<!-- awm:handoffs:end -->

## Other notable files
- PROJECT_OVERVIEW.md — onboarding primer (read after this file)
- PROTOCOL.md — rules, for agents without the awm MCP server
- LESSONS.md — lessons learned on this project (created on first awm_learn)

Last update: 2026-11-10 09:14
