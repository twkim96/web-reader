import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getGooglePickerAppId,
  pickGoogleDriveFiles,
} from '../src/lib/googlePicker.ts';

test('derives the Picker App ID from the OAuth client project number', () => {
  assert.equal(
    getGooglePickerAppId('123456789012-example.apps.googleusercontent.com'),
    '123456789012',
  );
  assert.equal(getGooglePickerAppId('invalid-client-id'), '');
});

test('rejects missing Picker credentials before loading the Google API script', async () => {
  await assert.rejects(
    () => pickGoogleDriveFiles('token', { apiKey: '', appId: '123' }),
    /API 키/,
  );
  await assert.rejects(
    () => pickGoogleDriveFiles('token', { apiKey: 'key', appId: '' }),
    /프로젝트 번호/,
  );
});
