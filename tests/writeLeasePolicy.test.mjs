import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_LEASE_DURATION_MS, RECEIPT_RETENTION_MS, WRITE_LEASE_REFRESH_MS,
  createLeasedEventId, parseLeasedEventId, isWriteLeaseValid, getEventLeaseStatus,
} from '../src/lib/writeLeasePolicy.ts';

const lease = { leaseId: '2af12345-1234-4123-8123-123456789abc', deviceId: 'device-1', issuedAtMillis: 1700000000123 };

test('leased event identity round trips and validates strict format', () => {
  const id = createLeasedEventId(lease);
  const parsed = parseLeasedEventId(id);
  assert.equal(parsed.leaseId, lease.leaseId);
  assert.equal(parsed.issuedAtMillis, lease.issuedAtMillis);
  assert.match(parsed.eventId, /^[0-9a-f-]{36}$/);
  assert.ok(id.length < 128);
  for (const bad of [id.toUpperCase(), id + '_extra', id.replace('1700000000123', '123'), 'wl1_bad']) {
    assert.equal(parseLeasedEventId(bad), null);
  }
  assert.throws(() => createLeasedEventId({ ...lease, issuedAtMillis: 1 }));
});

test('lease and event status reject future and expire at the exact boundary', () => {
  const id = createLeasedEventId(lease);
  const issued = lease.issuedAtMillis;
  assert.equal(WRITE_LEASE_REFRESH_MS, 864e5);
  assert.equal(RECEIPT_RETENTION_MS, 210 * 864e5);
  for (const [time, status, valid] of [
    [issued - 1, 'unleased', false], [issued, 'valid', true],
    [issued + WRITE_LEASE_DURATION_MS - 1, 'valid', true],
    [issued + WRITE_LEASE_DURATION_MS, 'expired', false],
  ]) {
    assert.equal(getEventLeaseStatus(id, time, true), status);
    assert.equal(isWriteLeaseValid(lease, time), valid);
  }
  assert.equal(getEventLeaseStatus('unleased_example', issued, false), 'unleased');
  assert.equal(getEventLeaseStatus('wl1_invalid', issued, false), 'unleased');
  assert.equal(getEventLeaseStatus('legacy', issued, false), 'legacy');
  assert.equal(getEventLeaseStatus('legacy', issued, true), 'unleased');
});
