import SevenZip from '../public/7z/7zz.es6.js';

const createBmp = (width, height, shade) => {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  const bytes = new Uint8Array(54 + pixelBytes);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  for (let offset = 54; offset < bytes.length; offset += 3) {
    bytes[offset] = shade;
    bytes[offset + 1] = (shade + 40) % 256;
    bytes[offset + 2] = (shade + 80) % 256;
  }
  return bytes;
};

export const createSolidSevenZipFixture = async ({
  pageCount = 6,
  width = 2048,
  height = 1536,
} = {}) => {
  const stdout = [];
  const stderr = [];
  const sevenZip = await SevenZip({
    print: (line) => stdout.push(line),
    printErr: (line) => stderr.push(line),
  });
  sevenZip.FS.mkdir('/fixture');
  for (let index = 1; index <= pageCount; index += 1) {
    sevenZip.FS.writeFile(
      `/fixture/${String(index).padStart(2, '0')}.bmp`,
      createBmp(width, height, index * 20),
    );
  }

  const createCode = sevenZip.callMain([
    'a',
    '-t7z',
    '-ms=on',
    '-mx=1',
    '-bb0',
    '-bsp0',
    '/solid-pages.7z',
    '/fixture/*',
  ]);
  if (createCode !== 0) {
    throw new Error(`7z fixture creation failed (${createCode}): ${stderr.join('\n')}`);
  }

  stdout.length = 0;
  stderr.length = 0;
  const listCode = sevenZip.callMain([
    'l',
    '-slt',
    '-bb0',
    '-bsp0',
    '/solid-pages.7z',
  ]);
  if (listCode !== 0 || !stdout.some((line) => line === 'Solid = +')) {
    throw new Error(`Generated fixture is not solid: ${stdout.join('\n')}`);
  }

  return new Uint8Array(sevenZip.FS.readFile('/solid-pages.7z'));
};
