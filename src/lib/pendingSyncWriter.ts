const LOCK_PREFIX = 'web-reader:unleased-sync-writer:';
const UNTRACKED_ID_PREFIX = 'unleased_untracked_';
const TRACKED_ID = /^unleased_v1_([0-9a-f-]{36})_[0-9a-f-]{36}$/;

const getLocks = () => {
  try { return typeof navigator === 'undefined' ? undefined : navigator.locks; }
  catch { return undefined; }
};

let writerId: string | undefined;
let writerReady: Promise<void> | undefined;

// A runtime never reacquires the identity of a previous producer.
export const preparePendingSyncWriter = (): Promise<void> => {
  if (writerReady) return writerReady;
  const locks = getLocks();
  if (!locks) return Promise.resolve();
  const id = crypto.randomUUID();
  const ready = new Promise<void>((resolve) => {
    const acquire = async () => {
      try {
        await locks.request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
          if (!lock) return;
          writerId = id;
          resolve();
          // The browser releases the lock when this execution ends.
          return new Promise<void>(() => undefined);
        });
      } catch {
        // Persist the work as untracked when liveness cannot be established.
      } finally {
        if (writerId === id) {
          writerId = undefined;
          writerReady = undefined;
        }
        resolve();
      }
    };
    void acquire();
  });
  writerReady = ready;
  void ready.then(() => {
    if (!writerId && writerReady === ready) writerReady = undefined;
  });
  return ready;
};

export const createPendingSyncWriterEventId = () => {
  const eventId = crypto.randomUUID();
  return writerId ? `unleased_v1_${writerId}_${eventId}` : `${UNTRACKED_ID_PREFIX}${eventId}`;
};

export const isUntrackedPendingSyncWriterEventId = (eventId: string) => eventId.startsWith(UNTRACKED_ID_PREFIX);

export const ownsPendingSyncWriterEventId = (eventId: string) => (
  writerId !== undefined && TRACKED_ID.exec(eventId)?.[1] === writerId
);

const lockName = (eventId: string) => {
  const writer = TRACKED_ID.exec(eventId)?.[1];
  return writer ? `${LOCK_PREFIX}${writer}` : undefined;
};

// Read candidate IDs before checking locks. A later row with the same writer
// name has no proof from this snapshot. A tracked identity is never reused,
// so it cannot reacquire its lock after absence has been observed. The caller
// excludes untracked events its own runtime can still bind.
export const readRecoverablePendingSyncEventIds = async (eventIds: readonly string[]): Promise<ReadonlySet<string>> => {
  const recoverable = new Set<string>();
  const tracked = new Map<string, string[]>();
  for (const eventId of eventIds) {
    const name = lockName(eventId);
    if (!name) recoverable.add(eventId);
    else {
      const ids = tracked.get(name);
      if (ids) ids.push(eventId);
      else tracked.set(name, [eventId]);
    }
  }
  if (!tracked.size) return recoverable;
  const locks = getLocks();
  if (!locks) return recoverable;
  try {
    const { held } = await locks.query();
    if (!held) return recoverable;
    const heldNames = new Set(held.map(({ name }) => name));
    for (const [name, ids] of tracked) {
      if (!heldNames.has(name)) {
        for (const id of ids) recoverable.add(id);
      }
    }
  } catch {
    // Unavailable lock state cannot prove that a tracked writer released it.
  }
  return recoverable;
};
