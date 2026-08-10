type ProgressRemoteHead = {
  revision: number;
  acceptedEventId: string;
  operation: string;
  position: unknown;
};

type RemoteHeadCarrier = {
  remoteHead?: unknown;
};

const readProgressRemoteHead = (value: RemoteHeadCarrier): ProgressRemoteHead | null => {
  const head = value.remoteHead;
  if (
    typeof head !== 'object'
    || head === null
    || !('position' in head)
    || !('revision' in head)
    || typeof head.revision !== 'number'
    || !('acceptedEventId' in head)
    || typeof head.acceptedEventId !== 'string'
    || !('operation' in head)
    || typeof head.operation !== 'string'
  ) return null;
  return head as ProgressRemoteHead;
};

export const hasSameRemoteProgressHead = (
  left: RemoteHeadCarrier,
  right: RemoteHeadCarrier,
) => {
  const leftHead = readProgressRemoteHead(left);
  const rightHead = readProgressRemoteHead(right);
  return Boolean(
    leftHead
    && rightHead
    && leftHead.revision === rightHead.revision
    && leftHead.acceptedEventId === rightHead.acceptedEventId
    && leftHead.operation === rightHead.operation
    && JSON.stringify(leftHead.position) === JSON.stringify(rightHead.position),
  );
};

export const shouldCancelRemoteProgressCommand = ({
  view,
  activeBookId,
  commandBookId,
}: {
  view: string;
  activeBookId?: string;
  commandBookId: string;
}) => view !== 'reader' || activeBookId !== commandBookId;

export const hasSameExpectedLocalProgressState = (
  left: unknown,
  right: unknown,
) => JSON.stringify(left) === JSON.stringify(right);
