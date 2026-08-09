import type { ReadingStatisticsExportFile } from './readingStatisticsExport';

const toFile = (exportFile: ReadingStatisticsExportFile) => new File(
  [exportFile.text],
  exportFile.filename,
  { type: exportFile.mimeType },
);

export const downloadReadingStatisticsExport = (exportFile: ReadingStatisticsExportFile) => {
  const url = URL.createObjectURL(new Blob([exportFile.text], { type: exportFile.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFile.filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const shareReadingStatisticsExport = async (exportFile: ReadingStatisticsExportFile) => {
  if (typeof File === 'undefined' || typeof navigator.share !== 'function') return false;
  const file = toFile(exportFile);
  if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
    return false;
  }
  await navigator.share({ files: [file], title: exportFile.filename });
  return true;
};

export const isReadingStatisticsShareCapabilityError = (error: unknown) => (
  error instanceof TypeError
  || (error instanceof DOMException && (
    error.name === 'NotSupportedError'
    || error.name === 'InvalidStateError'
  ))
);
