'use client';

import { FoliateSection, FoliateViewElement, TocItem } from './types';

const buildSectionFractions = (sections: FoliateSection[]) => {
  const sizes = sections.map((section) => (
    section.linear !== 'no' && (section.size || 0) > 0 ? section.size || 0 : 0
  ));
  const sizeTotal = sizes.reduce((a: number, b: number) => a + b, 0);

  const sectionFractions: number[] = [0];
  if (sizeTotal > 0) {
    let sum = 0;
    for (const size of sizes) sectionFractions.push((sum += size) / sizeTotal);
    return sectionFractions;
  }

  for (let i = 1; i <= sections.length; i++) {
    sectionFractions.push(i / sections.length);
  }
  return sectionFractions;
};

const findSectionIndexByHref = (sections: FoliateSection[], href: string) => {
  const hrefPath = href.split('#')[0].split('/').pop();
  if (!hrefPath) return -1;

  return sections.findIndex((section) => {
    const sectionPath = (section.id || section.href || '').split('/').pop();
    return Boolean(sectionPath && sectionPath === hrefPath);
  });
};

export const buildTocProgress = (view: FoliateViewElement): TocItem[] => {
  const sections = view.book?.sections || [];
  const sectionFractions = buildSectionFractions(sections);

  const enrichTocItems = (items: TocItem[]): TocItem[] => (
    items.map((item) => {
      const resolved = view.resolveNavigation(item.href);
      let index = (resolved && typeof resolved === 'object') ? (resolved.index ?? 0) : 0;

      if (index === 0 && item.href) {
        const foundIndex = findSectionIndexByHref(sections, item.href);
        if (foundIndex !== -1) index = foundIndex;
      }

      const enrichedItem: TocItem = {
        ...item,
        progress: (sectionFractions[index] || 0) * 100,
      };

      if (item.subitems && item.subitems.length > 0) {
        enrichedItem.subitems = enrichTocItems(item.subitems);
      }

      return enrichedItem;
    })
  );

  return enrichTocItems(view.book?.toc || []);
};
