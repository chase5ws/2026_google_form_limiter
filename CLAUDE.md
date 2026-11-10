<!-- awm:start -->
## Shared AI memory (AIMemory/)
- With the `awm` MCP tools: call `awm_context` before working; log `PROMPT` → `WORK_START` → `FILES_*` → `WORK_END` with `awm_log`; use `awm_search` for older history instead of reading archives.
- Without MCP: read `AIMemory/INDEX.md`, `AIMemory/PROJECT_OVERVIEW.md`, then the last ~20 events of `AIMemory/work.log`; rules in `AIMemory/PROTOCOL.md`.
<!-- awm:end -->
