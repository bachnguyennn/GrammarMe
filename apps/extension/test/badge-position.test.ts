import { describe, expect, it } from 'vitest';
import {
  MAX_BADGE_SITES,
  clampToArea,
  fractionFromPoint,
  movableArea,
  normalizeBadgePositions,
  placeFromFraction,
  withBadgePosition,
} from '../src/badge-position.ts';

const field = { left: 100, top: 50, right: 700, bottom: 250 };

describe('movable area and fractions', () => {
  it('keeps the badge inside the field, leaving room for the AI button on its left', () => {
    const a = movableArea(field, 20, 20, 30);
    expect(a).toEqual({ left: 134, top: 54, right: 676, bottom: 226 });
  });

  it('round-trips a dropped position, and scales it to a field of another size', () => {
    const a = movableArea(field, 20, 20, 0);
    const pos = fractionFromPoint(a, 104, 54); // top-left corner
    expect(pos).toEqual({ fx: 0, fy: 0 });
    const mid = fractionFromPoint(a, (a.left + a.right) / 2, (a.top + a.bottom) / 2);
    expect(mid).toEqual({ fx: 0.5, fy: 0.5 });

    const small = movableArea({ left: 0, top: 0, right: 300, bottom: 100 }, 20, 20, 0);
    expect(placeFromFraction(small, mid)).toEqual({ left: 140, top: 40 });
  });

  it('clamps drags and stored values that fall outside the field', () => {
    const a = movableArea(field, 20, 20, 0);
    expect(clampToArea(a, 0, 999)).toEqual({ left: a.left, top: a.bottom });
    expect(fractionFromPoint(a, -50, 9999)).toEqual({ fx: 0, fy: 1 });
    expect(placeFromFraction(a, { fx: 7, fy: -3 })).toEqual({ left: a.right, top: a.top });
  });

  it('copes with a field smaller than the badge (single-line inputs)', () => {
    const tiny = movableArea({ left: 0, top: 0, right: 200, bottom: 24 }, 20, 20, 0);
    expect(tiny.bottom).toBe(tiny.top);
    expect(fractionFromPoint(tiny, 50, 4).fy).toBe(1);
  });
});

describe('stored positions', () => {
  it('normalises storage: per site, bad entries dropped, values clamped', () => {
    expect(
      normalizeBadgePositions({ 'www.Example.com': { fx: 0.2, fy: 2 }, bad: { fx: 'x' }, 'mail.google.com': { fx: 0, fy: 0 } }),
    ).toEqual({ 'example.com': { fx: 0.2, fy: 1 }, 'mail.google.com': { fx: 0, fy: 0 } });
    expect(normalizeBadgePositions(null)).toEqual({});
  });

  it('sets, resets and caps the number of sites', () => {
    let m = withBadgePosition({}, 'www.reddit.com', { fx: 0, fy: 1 });
    expect(m).toEqual({ 'reddit.com': { fx: 0, fy: 1 } });
    m = withBadgePosition(m, 'reddit.com', null);
    expect(m).toEqual({});
    for (let i = 0; i < MAX_BADGE_SITES + 5; i++) m = withBadgePosition(m, `site${i}.example`, { fx: 0, fy: 0 });
    expect(Object.keys(m)).toHaveLength(MAX_BADGE_SITES);
    expect(m['site0.example']).toBeUndefined();
    expect(m[`site${MAX_BADGE_SITES + 4}.example`]).toBeDefined();
  });
});
