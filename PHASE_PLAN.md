# Refactor Phase Plan

## Summary
- 큰 리팩터를 한 번에 하지 않고, 각 phase를 테스트 가능한 1커밋 단위로 나눈다.
- 사용자는 현재 1명이므로 `charIndex`, v2 마이그레이션, TXT 리더 문서 흔적은 호환 고려 없이 제거한다.
- 각 phase 완료 후 기본 검증은 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run build`이다.
- 커밋/푸쉬는 사용자가 로컬 테스트를 마치고 요청한 뒤 진행한다.
- 여러 기기/Vercel 테스트가 필요할 때는 사용자가 요청하면 commit + push까지 수행한다.

## Current State
- Working tree has uncommitted Phase 5 changes. Do not commit until the user asks.
- Phase 5 code has been implemented and reviewed once.
- Latest Phase 5 validation passed:
  - `npx tsc --noEmit`
  - changed-file ESLint
  - `npm run build`
  - `git diff --check`
- Current uncommitted files:
  - `src/app/page.tsx`
  - `src/hooks/useAuthBootstrap.ts`
  - `src/hooks/useLibraryData.ts`
  - `src/hooks/progressPolicy.ts`
  - `src/hooks/useProgressActions.ts`
  - `src/hooks/useProgressSync.ts`

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
- Implemented but not committed.
- Waiting for user testing.

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

## Next Phases

### Phase 6: Foliate Adapter Split
- Split `src/hooks/useEpubReader.ts` into Foliate-specific adapter layers.
- Target pieces:
  - `useFoliateView`: `/foliate-js/view.js` loading and custom element creation
  - `useFoliateNavigation`: `goTo`, `goToFraction`, `prev`, `next`
  - `useFoliateLayout`: style/layout injection
  - `useFoliateSearch`: full-text search
  - `buildTocProgress`: pure TOC progress calculation
  - `installScrollBoundaryNavigation`: scroll/touch boundary navigation
- Goal: make the Foliate engine boundary clear before deeper Reader work.

### Phase 7: Reader Split
- Split `src/components/EpubReader.tsx` by feature.
- Target pieces:
  - `useReaderBookSource`: localDB/Drive source loading and TXT-to-EPUB guarantee
  - `useReaderBookmarks`: manual/auto bookmark state and preview text
  - `useRemoteProgressPrompt`: remote progress prompt/conflict handling
  - `useReaderChrome`: controls, modal state, history popstate
  - UI pieces such as `ReaderToolbar`, `JumpDialog`, `SyncConflictDialog`
- Goal: leave `EpubReader` as EPUB screen composition, not a mixed state machine.

### Phase 8: Final Lint/Docs Cleanup
- Clean `src` lint errors as much as practical.
- Consider treating `public/foliate-js` as vendor code and excluding it from lint.
- Update README to match current EPUB/Foliate/Drive-original-upload architecture.
- Full validation:
  - `npx tsc --noEmit`
  - `npx eslint src`
  - `npm run build`
  - local/cloud TXT and EPUB upload/open
  - progress/bookmark persistence
  - Vercel deployment check

## Commit Strategy
- Keep each phase as an independent commit.
- Do not commit user-untested phase changes unless the user explicitly requests it.
- After user testing, commit and push when requested.
- Avoid mixing future phase work into the current phase commit.
- If a regression appears, prefer fixing inside the current phase before commit; after commit, keep rollback scope phase-sized.

