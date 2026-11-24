import type { DiscoveryBook } from './bookDiscovery';
import type { PublicBookPlatformId } from './publicBookMetadataSchema';

type ScoredDiscoveryBook = [book: DiscoveryBook, score: number];

const platformGapThreshold = 0.15;
const maximumPlatformBonus = 0.2;

export function weightDiscoveryPlatformMix(candidates: readonly ScoredDiscoveryBook[]): ScoredDiscoveryBook[] | null {
  const counts = new Map<PublicBookPlatformId, number>();
  const choices = candidates.map(([book]) => [...new Set(book.platforms.map(({ id }) => id))]);
  for (const platforms of choices) {
    for (const platform of platforms) {
      // Each work contributes one vote, split among its available platforms.
      counts.set(platform, (counts.get(platform) ?? 0) + 1 / platforms.length);
    }
  }
  if (counts.size < 2) return null;
  const mostCommon = Math.max(...counts.values());
  const leastCommon = Math.min(...counts.values());
  // Keep small differences from changing the ranking.
  if (mostCommon - leastCommon <= candidates.length * platformGapThreshold) return null;

  return candidates.map(([book, score], index): ScoredDiscoveryBook => {
    const platforms = choices[index];
    if (!platforms.length) return [book, score];
    const gap = platforms.reduce((sum, id) => sum + mostCommon - counts.get(id)!, 0) / platforms.length;
    const bonus = maximumPlatformBonus * Math.max(0, gap / candidates.length - platformGapThreshold)
      / (1 - platformGapThreshold);
    return [book, score * (1 + bonus)];
  });
}

function discoveryRotationWeight(id: string, seed: number) {
  let hash = seed ^ 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (((hash ^ (hash >>> 16)) >>> 0) + 0.5) / 0x1_0000_0000;
}

export function sampleDiscoveryBooks(candidates: readonly ScoredDiscoveryBook[], seed: number, limit: number) {
  // Independent exponential draws sample without replacement in proportion to weight.
  return candidates.map(([book, weight]) => ({ book, draw: -Math.log(discoveryRotationWeight(book.id, seed)) / weight }))
    .sort((a, b) => a.draw - b.draw)
    .slice(0, limit)
    .map(({ book }) => book);
}
