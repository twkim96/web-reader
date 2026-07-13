export type SnapshotDocumentChange<T> = {
  type: 'added' | 'modified' | 'removed';
  doc: T;
};

export class ServerSnapshotHydrator<T> {
  private hydrated = false;

  select(snapshot: {
    metadata: { fromCache: boolean };
    docs: T[];
    docChanges: () => SnapshotDocumentChange<T>[];
  }): SnapshotDocumentChange<T>[] | null {
    if (snapshot.metadata.fromCache) return null;
    if (!this.hydrated) {
      this.hydrated = true;
      return snapshot.docs.map((doc) => ({ type: 'added', doc }));
    }
    return snapshot.docChanges();
  }
}
