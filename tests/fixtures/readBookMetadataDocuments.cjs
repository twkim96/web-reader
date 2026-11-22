exports.getDoc = (reference) => globalThis.readBookTestDocument(reference);
exports.loadPublicBookMetadata = (title, read) => globalThis.readBookTestTitle(title, read);
exports.readSharedPublicBookMetadataDocument = async (reference) => {
  const startedAt = Date.now();
  return { snapshot: await globalThis.readBookTestDocument(reference), startedAt };
};
