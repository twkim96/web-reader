export type ReadingActivityTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export const reconcileReadingActivityTargets = (
  attached: Map<ReadingActivityTarget, readonly string[]>,
  currentTargets: ReadonlySet<ReadingActivityTarget>,
  eventNames: readonly string[],
  listener: EventListener,
) => {
  for (const target of currentTargets) {
    if (attached.has(target)) continue;
    for (const eventName of eventNames) {
      target.addEventListener(eventName, listener, { capture: true, passive: true });
    }
    attached.set(target, eventNames);
  }
  for (const [target, names] of attached) {
    if (currentTargets.has(target)) continue;
    for (const eventName of names) {
      target.removeEventListener(eventName, listener, { capture: true });
    }
    attached.delete(target);
  }
};

export const detachReadingActivityTargets = (
  attached: Map<ReadingActivityTarget, readonly string[]>,
  listener: EventListener,
) => {
  for (const [target, names] of attached) {
    for (const eventName of names) {
      target.removeEventListener(eventName, listener, { capture: true });
    }
  }
  attached.clear();
};
