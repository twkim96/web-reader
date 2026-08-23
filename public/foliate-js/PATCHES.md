# Local Foliate patches

The files in this directory are vendored runtime code. Keep these patches and
their regression tests when updating from upstream.

## 1.8.33 passive scrolled input

- `paginator.js` rebinds its touch listeners when `flow` changes. Scrolled mode uses a passive `touchmove` listener while paginated swipe mode retains the cancelable listener it needs for custom page movement.
- The scrolled container uses `overscroll-behavior: contain`, allowing the app's boundary navigation to rely on passive touch start/end distance checks instead of a blocking move listener.
- App-owned publication wheel/touch bindings use the same mode-specific policy; a blocking touchmove exists only while the reader controls intentionally freeze the document.
- Node policy/source regression and Chromium/WebKit Foliate compatibility coverage preserve page swipe, section navigation, annotations, and runtime cache behavior.
- Runtime revision `1.8.33` prevents clients from reusing the pre-optimization paginator.

## 1.7.0 locale and media-overlay lookup

- `view.js`: use the BCP 47 language code `ko` instead of `kr` when deciding
  whether a publication language is CJK.
- `view.js`: compare renderer content indexes instead of assigning to them.
- `fixed-layout.js`: preserve each loaded section index in `getContents()` so
  media-overlay lookup has the same contract as paginator lookup.
- Regression coverage: `tests/foliateViewRegression.test.mjs` and
  `tests/e2e/foliateSandboxCompatibility.spec.ts`.

## 1.8.17 foreground programmatic navigation readiness

- `paginator.js` returns `false` instead of an ambiguous `undefined` when a programmatic `goTo()` arrives while a page turn is locked or the target is invalid.
- `paginator.js` exposes `waitForNavigationReady()` so remote-progress adoption can wait for page-turn unlock plus font/image/resize pagination stabilization before committing the canonical remote position.
- `view.js` forwards the readiness boundary to the app. Ordinary TOC/search/manual navigation is unchanged; the barrier is consumed only by the remote-progress adoption path.
- Chromium/WebKit regression coverage verifies locked `goTo()` rejection, readiness settlement, and successful retry.
- Runtime revision `1.8.17.1` prevents an older cached paginator from bypassing the fix.

## 1.8.22 host-frame staging pagination

- `View.waitForReaderFont()` no longer waits on the hidden publication iframe's `requestAnimationFrame`; it waits on the visible paginator document's frame before running the existing synchronous `expand()` layout pass.
- `View.waitForPagination()` uses the same host-frame rule for staged section-end and stable pagination, so previous-section navigation and remote stable navigation do not retain the same hidden-subframe throttle risk.
- The change preserves font/image readiness, the existing three-frame stabilization count, final synchronous geometry calculation, abort handling, and staging visibility semantics.
- Chromium/WebKit regression coverage verifies reader-font staging uses at least one host frame and section-end staging uses all three host frames while preserving section-boundary behavior.
- Runtime revision `1.8.22.1` prevents iPad clients from reusing the throttled 1.8.21 paginator.

## 1.8.21 reader-font stabilization timing split

- `paginator.js` splits the existing `ridi-font` stabilization measurement into `document.fonts.load()`, one animation-frame wait, the final `expand()`, and the two layout-forcing `getBoundingClientRect()` calls used to calculate multi-column page count.
- The detailed timings are collected only around the already-required operations; timing reads do not add new geometry/layout queries, and an app-managed counter disables the detailed measurements after initial book open.
- The outer `foliate-section-stabilize` measurement is captured before timing events are dispatched, so diagnostic event delivery is not counted as reader work.
- Chromium/WebKit regression coverage verifies all detailed font/pagination timing phases are emitted for a RIDIBatang section transition.
- Runtime revision `1.8.21.1` prevents iPad clients from reusing the 1.8.20 paginator.

## 1.8.20 reader-open timing and pre-view safety

- `view.js` emits privacy-safe cold-open timing events for ZIP indexing, EPUB package/TOC initialization, and progress-index setup so iPad-only startup stalls can be separated from section layout cost.
- `paginator.js` emits initial section load, stabilization, and anchor timing with only section index/size metadata.
- `paginator.js` treats `viewSize` as `0` before the first internal view exists and ignores `snap()` until both a view and scroll bounds are ready. This prevents iPad touch/layout ordering from dereferencing `this.#view.element` during a cloud-book first open.
- The app exports these timings through the existing reading-statistics diagnostics JSON without requiring the hidden bootstrap debug flag.
- Chromium/WebKit regression coverage verifies pre-view size/page/snap probes no longer throw.
- Runtime revision `1.8.20.1` prevents clients from reusing the 1.8.19 renderer.

## 1.8.19 paginated section-boundary tap fast path

- `paginator.js` lets discrete paginated `next()` / `prev()` calls jump directly from the last/first real content page to the adjacent spine section instead of visiting the blank outer sentinel first.
- While the next section is staged, resize callbacks from the outgoing view no longer re-anchor that soon-to-be-discarded document. This avoids a full visible-range/CFI geometry scan over large TXT-generated chapters on iPad WebKit.
- Swipe/snap navigation keeps its sentinel behavior; the optimization is limited to discrete page turns and does not change within-section pagination.
- Chromium/WebKit regression coverage verifies no outgoing range scan or transient relocation occurs at the boundary, previous-section end positioning still resolves correctly, and failed section loads still recover.
- Runtime revision `1.8.19.1` prevents clients from reusing the pre-fix paginator.

## 1.8.18 stable remote target navigation and lock cleanup

- `view.js` exposes remote-only stable CFI/fraction navigation. `paginator.js` keeps the target section staged until fonts, images, and repeated layout expansion settle, then applies the target anchor and confirms two final layout frames before resolving.
- Programmatic remote conflict navigation now uses this target-aware path rather than stabilizing only the section that happened to be visible before the jump.
- `paginator.js` releases the page-turn lock in `finally`, including section-load and renderer exceptions, so one malformed navigation cannot permanently block later recovery.
- Chromium/WebKit regression coverage verifies locked navigation rejection, exception cleanup, cross-section stable pagination, and later recovery.
- Runtime revision `1.8.18.1` ensures clients do not reuse the 1.8.17 renderer after these vendored changes.

## 1.8.11 previous-section end anchor

- `paginator.js` keeps a previous section staged while applying reader styles,
  waiting for images and fonts, and expanding columns across three consecutive
  layout frames. It then navigates directly to the calculated final content
  page (`pages - 2`) instead of estimating the destination from a Range or
  geometric fraction.
- Chromium/WebKit regression coverage opens a multi-page previous section,
  enters the next section, navigates back once, and verifies that the final
  chapter marker is in the visible page range.
- The Foliate entry and paginator import use runtime revision `1.8.11.2`, so
  an existing 1.8.11 service-worker cache cannot serve the pre-patch modules.

## 1.7.0 publication sandbox gate

- `paginator.js` and `fixed-layout.js` share `sandbox-policy.js`. WebKit bug
  218086 prevents parent-realm listeners when `allow-scripts` is absent, so the
  renderer prepares every document through the sanitizer/CSP boundary before
  using `allow-same-origin allow-scripts`.
- Automated Chromium/WebKit coverage verifies that publication scripts and
  inline handlers are blocked while parent-controlled click, keyboard, touch,
  selection, navigation, and fixed-layout events continue to work.
- This is not a return to the old raw `allow-scripts` boundary: an unsupported
  or unreadable publication document fails closed before iframe navigation.
- Gate result: pending the full Chromium/WebKit rerun.

## 1.7.0 publication sanitizer and CSP

- `publication-sanitizer.js` removes executable and nested-document elements,
  inline event handlers, refresh/base directives, dangerous URL schemes, remote
  CSS URLs/imports, and injects a restrictive publication CSP.
- `epub.js` sanitizes both replacement-loader documents and direct EPUB section
  documents before serialization or rendering.
- Node DOM fixtures cover script/handler removal, URL filtering, safe package
  links, external anchor hardening, and CSS token bypasses.
- Browser security and compatibility proof remains gated on the Chromium/WebKit
  sandbox run; failure keeps the 1.7.0 release blocked.
