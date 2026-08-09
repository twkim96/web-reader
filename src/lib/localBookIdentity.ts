export const createLocalBookId = (
  createUuid: () => string = () => crypto.randomUUID(),
) => `local-${createUuid()}`;
