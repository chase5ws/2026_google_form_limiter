<!-- easy-mcp:start -->
## Shared AI memory (AIMemory/)
- With the `easy` MCP server: call `memory_context` before working; log `PROMPT` → `WORK_START` → `FILES_*` → `WORK_END` with `memory_log`; record corrections with `lesson_add`; use `memory_search` for older history.
- Without it: read `AIMemory/INDEX.md`, `AIMemory/PROJECT_OVERVIEW.md`, `AIMemory/LESSONS.md` and the last ~20 events of `AIMemory/work.log`; rules in `AIMemory/PROTOCOL.md`.
<!-- easy-mcp:end -->
