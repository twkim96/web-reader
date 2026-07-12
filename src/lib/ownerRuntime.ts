import type { OwnerKey } from './ownerIdentity';

export type OwnerSnapshot = Readonly<{
  ownerKey: OwnerKey;
  generation: number;
}>;

type OwnerDisposer = () => void;

export class OwnerRuntime {
  private generation = 0;
  private snapshot: OwnerSnapshot | null = null;
  private disposers = new Set<OwnerDisposer>();

  activate(ownerKey: OwnerKey) {
    if (this.snapshot?.ownerKey === ownerKey) return this.snapshot;
    this.invalidate();
    this.snapshot = Object.freeze({ ownerKey, generation: this.generation });
    return this.snapshot;
  }

  clear() {
    this.invalidate();
    this.snapshot = null;
  }

  capture() {
    return this.snapshot;
  }

  require() {
    const snapshot = this.snapshot;
    if (!snapshot) throw new Error('활성 로컬 서재가 없습니다.');
    return snapshot;
  }

  isCurrent(candidate: OwnerSnapshot | null | undefined) {
    return Boolean(
      candidate
      && this.snapshot
      && candidate.ownerKey === this.snapshot.ownerKey
      && candidate.generation === this.snapshot.generation,
    );
  }

  registerDisposer(disposer: OwnerDisposer) {
    this.disposers.add(disposer);
    return () => this.disposers.delete(disposer);
  }

  private invalidate() {
    this.generation += 1;
    const disposers = [...this.disposers];
    this.disposers.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn('[OwnerRuntime] Failed to dispose previous owner task:', error);
      }
    }
  }
}

export const ownerRuntime = new OwnerRuntime();
