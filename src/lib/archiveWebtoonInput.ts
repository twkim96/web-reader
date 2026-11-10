type WebtoonInputOptions = {
  scroll: (distance: number, allowTurn: boolean) => Promise<boolean>;
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
};

// Direct finger tracking, with a short inertial tail after release. Wheel input
// is blended across frames so a mouse wheel does not move in discrete jumps.
export const createArchiveWebtoonInput = ({
  scroll,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
  now = () => performance.now(),
}: WebtoonInputOptions) => {
  let frame: number | null = null;
  let pending = 0;
  let velocity = 0;
  let lastFrame = 0;
  let generation = 0;
  let touch: { start: number; last: number; time: number; moved: boolean } | null = null;

  const schedule = () => { if (frame === null) frame = requestFrame(step); };
  const step = (time: number) => {
    frame = null;
    const dt = lastFrame ? Math.min(32, Math.max(1, time - lastFrame)) : 16;
    lastFrame = time;
    const wheelPart = Math.abs(pending) < 0.5 ? pending : pending * (1 - Math.exp(-dt / 45));
    pending -= wheelPart;
    const distance = wheelPart + velocity * dt;
    velocity *= Math.exp(-dt / 180);
    const token = generation;
    if (!distance) return;
    void scroll(distance, true).then(turned => {
      if (token !== generation) return;
      // A fling may finish the current image, but must not skip the next one.
      if (turned) { pending = 0; velocity = 0; }
      if (Math.abs(pending) > 0.1 || Math.abs(velocity) > 0.02) schedule();
      else lastFrame = 0;
    });
  };
  const reset = () => {
    generation++;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    pending = velocity = lastFrame = 0;
    touch = null;
  };
  return {
    wheel(delta: number) {
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.1) return;
      velocity = 0;
      pending += delta;
      schedule();
    },
    touchStart(y: number) {
      reset();
      touch = { start: y, last: y, time: now(), moved: false };
    },
    touchMove(y: number) {
      if (!touch) return false;
      const time = now();
      const distance = touch.last - y;
      const dt = Math.max(8, time - touch.time);
      touch.last = y;
      touch.time = time;
      if (!touch.moved && Math.abs(touch.start - y) < 6) return false;
      touch.moved = true;
      velocity = Math.max(-3, Math.min(3, velocity * 0.35 + distance / dt * 0.65));
      const token = generation;
      void scroll(distance, true).then(turned => {
        if (turned && token === generation) velocity = 0;
      });
      return true;
    },
    touchEnd() {
      const gesture = touch;
      touch = null;
      if (!gesture?.moved) { velocity = 0; return false; }
      if (now() - gesture.time > 80) velocity = 0;
      if (Math.abs(velocity) > 0.02) schedule();
      return true;
    },
    cancelTouch: reset,
    reset,
  };
};
