import test from 'node:test';
import assert from 'node:assert/strict';

const { DriveLoadCoordinator } = await import('../src/lib/driveLoadCoordinator.ts');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('shares concurrent work for the same Drive session', async () => {
  const coordinator = new DriveLoadCoordinator();
  const gate = deferred();
  let runs = 0;
  const work = async () => {
    runs += 1;
    await gate.promise;
    return true;
  };

  const first = coordinator.run('session-a', work);
  const second = coordinator.run('session-a', work);
  assert.equal(first, second);
  assert.equal(runs, 1);
  gate.resolve();
  assert.equal(await first, true);
});

test('a newer Drive session invalidates and aborts the older session', async () => {
  const coordinator = new DriveLoadCoordinator();
  const oldGate = deferred();
  let oldContext;

  const oldRun = coordinator.run('session-a', async (context) => {
    oldContext = context;
    await oldGate.promise;
    return coordinator.isCurrent(context);
  });
  const newRun = coordinator.run('session-b', async (context) => (
    coordinator.isCurrent(context)
  ));

  assert.equal(oldContext.signal.aborted, true);
  assert.equal(await newRun, true);
  oldGate.resolve();
  assert.equal(await oldRun, false);
});
