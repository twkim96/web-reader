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

## 1.7.0 publication sandbox gate

- `paginator.js` and `fixed-layout.js` share `sandbox-policy.js` and omit
  `allow-scripts` from publication frames.
- Automated Chromium/WebKit coverage verifies that publication scripts and
  inline handlers are blocked while parent-controlled click, keyboard, touch,
  selection, navigation, and fixed-layout events continue to work.
- Gate result: pending the Phase 1 browser run.
