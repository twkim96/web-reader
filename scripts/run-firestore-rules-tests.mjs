import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';

const env = {
  ...process.env,
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
};

if (process.platform === 'darwin') {
  const javaHome = spawnSync('/usr/libexec/java_home', ['-v', '21'], {
    encoding: 'utf8',
  });
  if (javaHome.status === 0 && javaHome.stdout.trim()) {
    env.JAVA_HOME = javaHome.stdout.trim();
    env.PATH = `${resolve(env.JAVA_HOME, 'bin')}${delimiter}${env.PATH ?? ''}`;
  }
}

const firebaseBinary = resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'firebase.cmd' : 'firebase',
);
const result = spawnSync(firebaseBinary, [
  'emulators:exec',
  '--only',
  'firestore',
  '--project',
  'demo-web-reader',
  'node --test tests/firestoreRules.test.mjs',
], { env, stdio: 'inherit' });

process.exit(result.status ?? 1);
