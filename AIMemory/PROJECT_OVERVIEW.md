# Project Overview — 2026_google_form_limiter

> 1-screen primer for any LLM joining this project. Detailed docs live in the
> files listed under "Where to look"; this file only points at them.

## What is this project?
Multi-organization Google Form quota platform: each org connects its own Google account, folder and GAS mail relay; the platform opens/closes forms by quota and schedule and sends waitlist emails.

## Tech stack
- Node.js ≥ 22.13, zero npm dependencies, built-in SQLite
- Google OAuth / Drive / Forms APIs; per-org Google Apps Script mail relay
- Railway (Dockerfile + railway.json, Volume at /data)
- Tests: npm test (test/platform/, mocked Google API)

## Key decisions locked in
- (add as they are made: YYYY-MM-DD (model-id) — decision — why)

## Active concerns
- (none recorded yet)

## Where to look
- README.md — architecture, file map and Railway deployment
- lib/ — one module per concern (see README)
- Recent activity → AIMemory/work.log; older history → awm_search

---
Last rebuild: 2026-11-10 09:14 by claude-opus-5-5
