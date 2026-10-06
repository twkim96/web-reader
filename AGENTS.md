<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Documentation

- Current specifications and guide map: [docs/SPEC.md](docs/SPEC.md).
- Unfinished work and pending acceptance: [docs/TODO.md](docs/TODO.md).
- Use `project-wiki` for documentation maintenance. Start at the index and relevant
  TODO entries; read only the linked feature/guide pages needed for the task.
- Keep changed specifications, operating instructions and TODO entries current in
  the same scoped change. Product contracts belong in `docs/SPEC/`, not here.
- `docs/updates/` and `PHASE_PLAN.md` preserve historical plans and evidence. Old
  unchecked items are not an independent current backlog; consult `docs/TODO.md`.
- `DESIGN.md` and `docs/book-metadata-publishing.md` are compatibility pointers.
  Preserve their existing anchor targets when updating routing.
- Keep `ui-kit/` guides alongside the independently copied kit. Historical Rules
  backups keep their existing paths. Git-ignored `.superloopy/` evidence and local
  runtime artifacts must not become tracked documentation during migration.

## Project safeguards

- Preserve unrelated dirty/untracked files; stage only confirmed task paths.
- Preserve active IndexedDB and Firestore data, outbox, revisions, receipts and
  tombstones. Follow [data recovery](docs/operations/deployment-and-recovery.md)
  before cleanup or rollback; never use a DB reset to mask a fixture failure.
- Keep Drive file access independent from Firebase-owned reading state; consult
  [the integration boundary](docs/integrations/firebase-and-drive.md).
- Keep current progress saving and provisional/remote navigation contracts in
  [the reader specification](docs/SPEC/reader-and-progress.md).
- Use [existing setup and checks](docs/development/setup-and-checks.md). For pure
  documentation/style changes, prefer diff/link or useful existing visual checks.
  Do not add tests that only copy tunable values or run redundant checks.
- Automated, CI, deployed and real-device acceptance are distinct. Keep missing
  evidence in TODO; documentation maintenance does not execute unrelated work.
