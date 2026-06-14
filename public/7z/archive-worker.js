import SevenZip from './7zz.es6.js';

const ARCHIVE_PATH = '/input/archive.7z';
const OUTPUT_ROOT = '/output';

let sevenZip;
let operationQueue = Promise.resolve();

const commandOutput = {
  stdout: [],
  stderr: [],
};

const runCommand = (args) => {
  commandOutput.stdout = [];
  commandOutput.stderr = [];
  const code = sevenZip.callMain(args);
  return {
    code,
    stdout: commandOutput.stdout,
    stderr: commandOutput.stderr,
  };
};

const ensureDirectory = (path) => {
  try {
    sevenZip.FS.mkdir(path);
  } catch (error) {
    if (!String(error).includes('File exists')) throw error;
  }
};

const parseEntries = (lines) => {
  const entries = [];
  let current = null;

  const finishEntry = () => {
    if (!current?.name) return;
    const directory = current.attributes?.startsWith('D') ?? false;
    entries.push({
      name: current.name,
      size: directory && current.size === undefined ? 0 : Number(current.size),
      directory,
      encrypted: current.encrypted === '+',
    });
    current = null;
  };

  for (const line of lines) {
    const pathMatch = line.match(/^Path = (.*)$/);
    if (pathMatch) {
      finishEntry();
      current = { name: pathMatch[1] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Size = ')) current.size = line.slice(7);
    else if (line.startsWith('Attributes = ')) current.attributes = line.slice(13);
    else if (line.startsWith('Encrypted = ')) current.encrypted = line.slice(12);
    else if (line === '') finishEntry();
  }
  finishEntry();
  return entries;
};

const listFiles = (path) => {
  const files = [];
  for (const name of sevenZip.FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const childPath = `${path}/${name}`;
    const stat = sevenZip.FS.stat(childPath);
    if (sevenZip.FS.isDir(stat.mode)) files.push(...listFiles(childPath));
    else files.push(childPath);
  }
  return files;
};

const removeTree = (path) => {
  for (const name of sevenZip.FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const childPath = `${path}/${name}`;
    const stat = sevenZip.FS.stat(childPath);
    if (sevenZip.FS.isDir(stat.mode)) {
      removeTree(childPath);
      sevenZip.FS.rmdir(childPath);
    } else {
      sevenZip.FS.unlink(childPath);
    }
  }
};

const clearOutputDirectory = (path) => {
  try {
    removeTree(path);
    sevenZip.FS.rmdir(path);
  } catch {
    // Worker termination releases MEMFS if 7-Zip left an incomplete tree.
  }
};

const initialize = async (blob) => {
  sevenZip = await SevenZip({
    locateFile: (name) => `/7z/${name}`,
    print: (line) => commandOutput.stdout.push(line),
    printErr: (line) => commandOutput.stderr.push(line),
  });
  ensureDirectory('/input');
  ensureDirectory(OUTPUT_ROOT);
  sevenZip.FS.mount(
    sevenZip.WORKERFS,
    { blobs: [{ name: 'archive.7z', data: blob }] },
    '/input',
  );

  let result;
  try {
    result = runCommand([
      'l',
      '-slt',
      '-ba',
      '-bb0',
      '-bsp0',
      '-p',
      '-sccUTF-8',
      ARCHIVE_PATH,
    ]);
  } catch (error) {
    // 7-Zip's WASM build throws a C++ exception pointer for encrypted headers.
    if (typeof error === 'number' || /^\d+$/.test(String(error))) {
      throw new Error('ENCRYPTED_ARCHIVE');
    }
    throw error;
  }
  if (result.code !== 0) {
    const output = [...result.stderr, ...result.stdout].join('\n');
    if (/password|encrypted/i.test(output)) {
      throw new Error('ENCRYPTED_ARCHIVE');
    }
    throw new Error('DAMAGED_ARCHIVE');
  }
  return parseEntries(result.stdout);
};

const extract = (requestId, entryName, mimeType) => {
  const outputDir = `${OUTPUT_ROOT}/${requestId}`;
  ensureDirectory(outputDir);

  try {
    const result = runCommand([
      'x',
      '-y',
      '-aoa',
      '-spd',
      '-bb0',
      '-bsp0',
      '-p',
      `-o${outputDir}`,
      ARCHIVE_PATH,
      entryName,
    ]);
    if (result.code !== 0) {
      const output = [...result.stderr, ...result.stdout].join('\n');
      if (/password|encrypted|wrong password/i.test(output)) {
        throw new Error('ENCRYPTED_ARCHIVE');
      }
      throw new Error('EXTRACT_FAILED');
    }

    const files = listFiles(outputDir);
    if (files.length !== 1) throw new Error('EXTRACT_FAILED');
    const data = sevenZip.FS.readFile(files[0]);
    return new Blob([data], { type: mimeType });
  } finally {
    clearOutputDirectory(outputDir);
  }
};

self.addEventListener('message', (event) => {
  const message = event.data;
  operationQueue = operationQueue.then(async () => {
    try {
      if (message.type === 'init') {
        const entries = await initialize(message.blob);
        self.postMessage({ id: message.id, ok: true, entries });
        return;
      }
      if (message.type === 'extract') {
        if (!sevenZip) throw new Error('WORKER_NOT_READY');
        const blob = extract(message.id, message.entryName, message.mimeType);
        self.postMessage({ id: message.id, ok: true, blob });
      }
    } catch (error) {
      self.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : 'WORKER_FAILED',
      });
    }
  });
});
