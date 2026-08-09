import type { AnnotationExportFile } from './annotationExport';

const toFile = (exportFile: AnnotationExportFile) => new File(
  [exportFile.text],
  exportFile.filename,
  { type: exportFile.mimeType },
);

export const downloadAnnotationExport = (exportFile: AnnotationExportFile) => {
  const url = URL.createObjectURL(new Blob([exportFile.text], { type: exportFile.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFile.filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const canShareAnnotationExport = (exportFile: AnnotationExportFile) => {
  if (
    typeof navigator === 'undefined'
    || typeof navigator.share !== 'function'
    || typeof File === 'undefined'
  ) return false;
  const file = toFile(exportFile);
  return typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
};

export const shareAnnotationExport = async (exportFile: AnnotationExportFile) => {
  if (typeof File === 'undefined') return false;
  const file = toFile(exportFile);
  if (
    typeof navigator.share !== 'function'
    || (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] }))
  ) return false;
  await navigator.share({ files: [file], title: exportFile.filename });
  return true;
};
