# Local Foliate patches

The files in this directory are vendored runtime code. Keep these patches and
their regression tests when updating from upstream.

## 1.7.0 locale and media-overlay lookup

- `view.js`: use the BCP 47 language code `ko` instead of `kr` when deciding
  whether a publication language is CJK.
- `view.js`: compare renderer content indexes instead of assigning to them.
- `fixed-layout.js`: preserve each loaded section index in `getContents()` so
  media-overlay lookup has the same contract as paginator lookup.
- Regression coverage: `tests/foliateViewRegression.test.mjs` and
  `tests/e2e/foliateSandboxCompatibility.spec.ts`.

## 1.8.11 previous-section end anchor

- `paginator.js` performs the first column expansion synchronously after a
  section iframe is rendered. It then anchors backward section navigation to
  the final rendered non-whitespace text (or visible media fallback), rather
  than geometric fraction `1`. This avoids both the two-sentinel-page race and
  trailing blank-column fallback to the first page.
- Chromium/WebKit regression coverage opens a multi-page previous section,
  enters the next section, navigates back once, and verifies that the final
  chapter marker is in the visible page range.
- The Foliate entry and paginator import use runtime revision `1.8.11.1`, so
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
