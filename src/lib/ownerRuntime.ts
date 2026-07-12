import type { OwnerKey } from './ownerIdentity';

export type OwnerSnapshot = Readonly<{
  ownerKey: OwnerKey;
  generation: number;
  storageMode: 'v5' | 'legacy-readonly';
}>;

type OwnerDisposer = () => void;

export class OwnerRuntime {
  private generation = 0;
  private snapshot: OwnerSnapshot | null = null;
  private disposers = new Set<OwnerDisposer>();

  activate(ownerKey: OwnerKey) {
    if (this.snapshot?.ownerKey === ownerKey) return this.snapshot;
    this.invalidate();
    this.snapshot = Object.freeze({
      ownerKey,
      generation: this.generation,
      storageMode: 'v5' as const,
    });
    return this.snapshot;
  }

  useLegacyReadOnly(candidate: OwnerSnapshot) {
    if (!this.isCurrent(candidate)) throw new Error('활성 서재가 변경되었습니다.');
    if (candidate.storageMode === 'legacy-readonly') return candidate;
    this.invalidate();
    this.snapshot = Object.freeze({
      ownerKey: candidate.ownerKey,
      generation: this.generation,
      storageMode: 'legacy-readonly' as const,
    });
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
