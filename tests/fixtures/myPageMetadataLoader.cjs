exports.loadReadBookMetadata = async (titles, options) => (
  globalThis.myPageTestMetadata?.(titles, options) ?? { metadata: new Map(), failed: new Set() }
);
