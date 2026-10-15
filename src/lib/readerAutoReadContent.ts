import { createReaderTtsRangeSource } from './readerTtsRange';
import { tokenizeAutoReadText, type AutoReadWord } from './readerAutoRead';

export type AutoReadContent = {
  sectionIndex: number;
  words: AutoReadWord[];
  initialIndex: number;
  getRange: (index: number) => Range | null;
};

// Reuse TTS's visible-text filtering, block separators and original DOM offsets.
// Ranges are created on demand, so a long chapter does not retain one per word.
export const createAutoReadContent = (
  doc: Document,
  sectionIndex: number,
  anchor?: Range,
): AutoReadContent => {
  const source = createReaderTtsRangeSource({ doc });
  const words = tokenizeAutoReadText(source.text);
  const getRange = (index: number) => {
    const word = words[index];
    if (!word) return null;
    const first = source.runs.find((run) => run.end > word.start);
    const last = source.runs.find((run) => run.end >= word.end);
    if (!first || !last) return null;
    const range = doc.createRange();
    range.setStart(first.node, first.nodeStart + Math.max(0, word.start - first.start));
    range.setEnd(last.node, last.nodeStart + Math.min(last.nodeEnd - last.nodeStart, word.end - last.start));
    return range;
  };
  let initialIndex = 0;
  if (anchor && anchor.startContainer.ownerDocument === doc) {
    const run = source.runs.find(({ node }) => node === anchor.startContainer);
    if (run) {
      const offset = run.start + Math.max(0, anchor.startOffset - run.nodeStart);
      initialIndex = words.findIndex(({ end }) => end > offset);
    } else {
      const marker = anchor.cloneRange();
      marker.collapse(true);
      const nextRun = source.runs.find((run) => {
        const range = doc.createRange();
        range.setStart(run.node, run.nodeStart);
        range.collapse(true);
        return marker.compareBoundaryPoints(0, range) <= 0;
      });
      initialIndex = nextRun ? words.findIndex(({ end }) => end > nextRun.start) : -1;
    }
    if (initialIndex < 0) initialIndex = Math.max(0, words.length - 1);
  }
  return { sectionIndex, words, initialIndex, getRange };
};
