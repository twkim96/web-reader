# Refactor Phase Plan

## Summary
- 큰 리팩터를 한 번에 하지 않고, 각 phase를 테스트 가능한 1커밋 단위로 나눈다.
- 사용자는 현재 1명이므로 `charIndex`, v2 마이그레이션, TXT 리더 문서 흔적은 호환 고려 없이 제거한다.
- 각 phase 완료 후 기본 검증은 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run build`이다.
- 커밋/푸쉬는 사용자가 로컬 테스트를 마치고 요청한 뒤 진행한다.
- 여러 기기/Vercel 테스트가 필요할 때는 사용자가 요청하면 commit + push까지 수행한다.

## Current State
- Phase 8 has been implemented but not committed.
- Current scope: final lint/docs cleanup plus the progress-slider follow-up.
- Latest validation passed:
  - `npx tsc --noEmit`
  - changed-file ESLint
  - `npm run build`
  - `git diff --check`

## Completed Phases

### Phase 1: Low-Risk Cleanup
- Removed TXT/`charIndex` leftovers and old migration/comment traces.
- Removed or cleaned unused imports/state/config/log candidates.
- Confirmed old dependency/build candidates are gone from tracked source:
  - `clsx`
  - `tailwind-merge`
  - `@nicolo-ribaudo/chokidar-2`
  - `next/font`
- `idb` is declared in `package.json`.
- Commit: `1d63e80 Clean up EPUB migration leftovers`

### Phase 2: Shelf Split
- Split shelf preferences/search/sort/offline-id logic.
- Added or used:
  - `useShelfPreferences`
  - `useOfflineBookIds`
  - `useFilteredBooks`
  - shelf book utility functions
- Fixed shelf sorting so 0.0% and 100% progress are treated as not currently reading.
- Commit: `dc43a02 Split shelf filtering and preferences`

### Phase 3: App Shell First Split
- Split low-risk app shell state out of `page.tsx`.
- Added:
  - `useViewerSettings`
  - `useDeviceId`
  - `useGoogleDriveToken`
  - `AuthScreens`
- Added Drive token expiry handling and modal-style cloud-session expiry feedback.
- Fixed theme/accent hydration behavior by avoiding localStorage reads during initial client render.
- Commit: `b7ed17b Extract auth settings hooks and handle expired Drive sessions`

### Phase 4: Library/Auth Bootstrap Split
- Note: this differed from the original Phase 4 plan. Actual Phase 4 split bootstrap/library loading before progress sync.
- Added:
  - `useLibraryData`
  - `useAuthBootstrap`
  - `useGoogleIdentityScript`
  - `useNetworkLibrarySync`
- `page.tsx` became more focused on app composition.
- Commit: `7e1b57b Extract library bootstrap hooks`

### Hotfix: Reader Open Must Not Corrupt Progress
- Fixed issue where simply opening a stored book could update `lastRead` and store `progressPercent: NaN`.
- Added finite progress guards and changed reader save behavior so progress is saved only after actual user-driven changes.
- Commit: `1c50ee2 Prevent reader open from corrupting progress`

## Phase 5: Progress Sync/Actions Split

### Status
- Completed.
- Commit: `c1aa644 Extract progress sync and clear expired cloud shelf`

### Changes
- Moved progress save/delete actions out of `page.tsx` into `useProgressActions`.
- Moved Firestore `readingHistory` snapshot subscription and remote progress detection into `useProgressSync`.
- Added `progressPolicy` for shared progress/bookmark rules:
  - Only manual bookmarks are saved to Firestore.
  - Auto bookmarks remain local-only.
  - `NaN` and non-finite progress values are blocked.
  - Identical progress/bookmark payloads do not refresh `lastRead`.
  - Remote manual bookmarks are merged with local auto bookmarks before local persistence.
- Reduced `useAuthBootstrap` to auth/bootstrap responsibilities only.
- Updated `syncLocalAndCloud` so it no longer overwrites local auto bookmarks with server-only manual bookmarks.
- Moved persistence side effects out of the React state updater in `useProgressActions`.

### Test Scope
- Open a book and immediately go back:
  - `lastRead` and `progressPercent` should remain unchanged.
- Move/scroll/page-turn and then leave reader:
  - progress and `lastRead` should update.
- Add/delete manual bookmarks:
  - manual bookmarks should sync to Firestore.
  - auto bookmarks should stay local-only.
- Trigger cloud/background sync:
  - local auto bookmarks should not disappear.
- Change manual bookmarks from another device:
  - local UI/localDB should update even if bookmark count stays the same.
- Remote progress from another device:
  - existing sync conflict prompt behavior should remain.
- Delete reading progress:
  - progress resets to 0 and the book sorts with unread/completed items.

### Hotfix: Remote Progress Accept Must Not Ping-Pong
- When accepting a remote progress prompt, the reader must jump to the remote location without creating an auto bookmark or saving the previous local position.
- After the accepted remote jump completes, the reader may save that post-move position with the current device ID to mark this device as the new active reader.
- Remote progress acceptance should update local reader refs (`lastSaveTime`, persisted CFI/percent) so the same remote update is not echoed back as a stale local write.

## Reader Navigation Save Policy
- For all jump/navigation flows, progress persistence should be based on the position after movement completes, not the position before movement starts.
- Before-move state may be used for local-only auto bookmarks, but it must not update Firestore as the latest reading progress.
- Explicit remote-progress acceptance should claim the current device after the move, even if CFI/percent are identical to the remote value.
- Phase 7 should revisit general jump flows (TOC/search/bookmark/% jump) and make this policy explicit in reader hooks.

## Phase 6: Foliate Adapter Split

### Status
- Completed after user testing.
- Commit: `Split Foliate adapter hooks`

### Changes
- Split `src/hooks/useEpubReader.ts` into Foliate-specific adapter layers.
- Added:
  - `src/hooks/foliate/useFoliateView.ts`: `/foliate-js/view.js` loading, custom element creation, load/relocate event binding
  - `src/hooks/foliate/useFoliateNavigation.ts`: `openBook`, `goTo`, `goToFraction`, `prev`, `next`
  - `src/hooks/foliate/useFoliateLayout.ts`: style/layout injection
  - `src/hooks/foliate/useFoliateSearch.ts`: full-text search and clear search
  - `src/hooks/foliate/toc.ts`: pure TOC progress calculation
  - `src/hooks/foliate/scrollBoundaryNavigation.ts`: scroll/touch boundary navigation
  - `src/hooks/foliate/types.ts` and `progress.ts`: shared Foliate adapter types/utilities
- Kept the public `useEpubReader` return API stable so `EpubReader.tsx` behavior remains isolated from this phase.
- Goal: make the Foliate engine boundary clear before deeper Reader work.
- Deferred work: none from the planned Phase 6 checklist. Remaining reader navigation save-policy cleanup belongs to Phase 7 because it lives in `EpubReader.tsx`, not the Foliate adapter.

### Test Scope
- Open a local EPUB and a cloud-cached EPUB.
- Open a TXT-origin book and confirm TXT-to-EPUB local cache still opens.
- Page mode navigation:
  - tap/click next and previous
  - CFI jump
  - percent slider jump
- Scroll mode navigation:
  - normal scroll
  - top/bottom boundary wheel navigation
  - mobile touch boundary navigation if available
- TOC modal:
  - TOC entries show progress
  - TOC jump opens the expected area
- Search modal:
  - search returns grouped results
  - selecting a result jumps correctly
  - clearing search removes highlights
- Reader settings:
  - font size, line height, font family, text alignment, theme, nav mode still apply.

## Phase 7: Reader Split

### Status
- Completed and pushed.
- Commit: `fc5eabd Split reader state and controls`

### Changes
- Split `src/components/EpubReader.tsx` by feature.
- Added:
  - `src/hooks/reader/useReaderBookSource.ts`: localDB/Drive source loading and TXT-to-EPUB guarantee
  - `src/hooks/reader/useReaderProgressSave.ts`: progress-save refs, relocate save policy, visibility/unmount save
  - `src/hooks/reader/useReaderBookmarks.ts`: manual/auto bookmark state, preview text, remote manual bookmark merge
  - `src/hooks/reader/useRemoteProgressPrompt.ts`: remote progress prompt/conflict handling
  - `src/hooks/reader/useReaderChrome.ts`: controls, modal state, history popstate
  - `src/components/reader/ReaderToolbar.tsx`: top/bottom reader controls
  - `src/components/reader/JumpDialog.tsx`: percent/CFI jump input
  - `src/components/reader/SyncConflictDialog.tsx`: remote progress prompt UI
- Updated navigation save policy in code:
  - TOC/search/bookmark/CFI/% jumps create local auto bookmarks from the pre-move position when needed.
  - Progress persistence is now based on the post-move relocate location.
  - Pre-move position is no longer saved as the latest Firestore progress during jump flows.
- Follow-up after user testing:
  - Remote progress prompt acceptance now also creates a local auto bookmark from the pre-move position before moving.
- Goal: leave `EpubReader` as EPUB screen composition, not a mixed state machine.

### Deferred Follow-Up: Progress Slider Auto Bookmark
- Implemented as a focused follow-up before Phase 8:
  - track slider drag start position once
  - update slider preview while dragging without creating bookmarks
  - call `goToFraction` once on pointer/key release or blur
  - create one auto bookmark only if the final target differs by more than 5% from the start position
  - save latest progress from the post-move relocate event
- This keeps slider movement aligned with the Reader Navigation Save Policy.

### Test Scope
- Local EPUB open and return to shelf.
- Cloud EPUB open and return to shelf.
- TXT-origin book open, confirming TXT-to-EPUB cache still works.
- Page mode:
  - tap/click previous and next
  - progress saves after real movement
- Jump flows:
  - percent jump
  - progress slider drag/release
  - CFI jump
  - TOC jump
  - search result jump
  - bookmark jump
  - auto bookmark should point to the pre-jump location, while latest progress should point to the post-jump location.
- Manual bookmarks:
  - add/delete
  - sync to another device
- Remote progress:
  - prompt appears from another device
  - accepting prompt creates a local auto bookmark, moves, and claims current device without ping-pong
  - ignoring prompt does not move
- Reader chrome:
  - top/bottom controls toggle
  - settings/theme/bookmark/TOC/search/jump modals open and close
  - browser back closes modals first, then exits reader
- Settings:
  - font size, line height, font family, text alignment, theme, nav mode still apply.

## Phase 8: Final Lint/Docs Cleanup

### Status
- Implemented but not committed.
- Waiting for user testing.

### Changes
- Completed the progress slider follow-up:
  - slider movement previews during drag
  - `goToFraction` runs once on pointer/key release or blur
  - auto bookmark is created at most once when final target differs by more than 5%
  - latest progress is still saved from the post-move relocate event
- Refined relocate save timing:
  - explicit jumps and slider releases save immediately after the post-move relocate event
  - ordinary page/scroll movement saves after 1 second of idle
  - continuous movement is capped with a 5 second max unsaved interval
  - visibility change/unmount still flushes the final location
- Cleaned `src` lint errors:
  - removed remaining `any` types in touched UI components
  - fixed unescaped JSX quotes
  - resolved React Compiler effect warnings
  - removed unused Firebase catch binding
- Updated README to match current EPUB/Foliate/Drive-original-upload architecture and the reader hook structure.
- `public/foliate-js` remains outside `src` lint scope, so no additional vendor ignore was needed for the Phase 8 validation command.

### Full Validation
- `npx tsc --noEmit`
- `npx eslint src`
- `npm run build`
- `git diff --check`

### Test Scope
- Local/cloud TXT and EPUB upload/open.
- Progress/bookmark persistence.
- Ordinary page/scroll movement:
  - should save soon after movement stops
  - should not write every tiny relocate event during continuous movement
- Progress slider drag/release:
  - no repeated jumps while dragging
  - one auto bookmark only after a meaningful final move
  - latest progress points to the post-release destination
- Vercel deployment check after commit + push.

## Next Phases

### Post-Cleanup Follow-Ups
- Use real-device testing to identify any remaining bookmark/progress sync edge cases.
- Continue feature work such as bookmark/content sync improvements from the now-smaller Reader and sync hooks.

## Commit Strategy
- Keep each phase as an independent commit.
- Do not commit user-untested phase changes unless the user explicitly requests it.
- After user testing, commit and push when requested.
- Avoid mixing future phase work into the current phase commit.
- If a regression appears, prefer fixing inside the current phase before commit; after commit, keep rollback scope phase-sized.
