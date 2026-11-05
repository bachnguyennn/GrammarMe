export interface TextStats {
  words: number;
  characters: number;
  sentences: number;
  /** Minutes at 238 wpm (average adult silent reading speed). */
  readingMinutes: number;
  /** Flesch Reading Ease, 0–100+, higher = easier. null for very short texts. */
  readability: number | null;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

export function textStats(text: string): TextStats {
  const words = text.match(WORD) ?? [];
  const sentences = Math.max(words.length ? 1 : 0, (text.match(/[.!?]+(?=\s|$)/g) ?? []).length);
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const readability =
    words.length >= 30 && sentences > 0
      ? Math.round(206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length))
      : null;
  return {
    words: words.length,
    characters: text.length,
    sentences,
    readingMinutes: words.length / 238,
    readability,
  };
}

export function readabilityLabel(score: number | null): string {
  if (score === null) return 'Write a little more';
  if (score >= 80) return 'Very easy to read';
  if (score >= 60) return 'Easy to read';
  if (score >= 50) return 'Fairly difficult';
  if (score >= 30) return 'Difficult';
  return 'Very difficult';
}
