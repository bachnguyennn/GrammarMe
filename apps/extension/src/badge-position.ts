/**
 * Where GrammarMe's badge sits inside a text field, when the user has dragged it (like Grammarly's
 * button). Pure helpers, unit-tested without a DOM.
 *
 * A position is stored per site as fractions of the area the badge can move in, not as pixels:
 * the same spot ("bottom-left", "top-right"…) then works for every field on that site, whatever its
 * size. `null` means the default corner (bottom-right).
 */
import { siteKey } from './settings.ts';

export interface BadgePos {
  /** 0 = left edge, 1 = right edge of the movable area. */
  fx: number;
  /** 0 = top edge, 1 = bottom edge of the movable area. */
  fy: number;
}

/** chrome.storage.local key: { [siteKey]: BadgePos }. Stays on this device. */
export const BADGE_POS_KEY = 'badgePositions';
export const MAX_BADGE_SITES = 200;
/** Pointer movement (px) before a press on the badge counts as a drag instead of a click. */
export const DRAG_THRESHOLD = 4;
/** Gap kept between the badge and the field's edges. */
export const EDGE_PAD = 4;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Top-left corners the badge may take inside `box`, leaving room for the AI button on its left. */
export function movableArea(box: Box, badgeW: number, badgeH: number, leadW: number, pad = EDGE_PAD): Box {
  const left = box.left + pad + leadW;
  const top = box.top + pad;
  const right = Math.max(left, box.right - pad - badgeW);
  const bottom = Math.max(top, box.bottom - pad - badgeH);
  return { left, top, right, bottom };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

export function placeFromFraction(area: Box, pos: BadgePos): { left: number; top: number } {
  return {
    left: area.left + clamp01(pos.fx) * (area.right - area.left),
    top: area.top + clamp01(pos.fy) * (area.bottom - area.top),
  };
}

/** Clamp a dragged top-left corner into the area. */
export function clampToArea(area: Box, left: number, top: number): { left: number; top: number } {
  return { left: Math.min(area.right, Math.max(area.left, left)), top: Math.min(area.bottom, Math.max(area.top, top)) };
}

export function fractionFromPoint(area: Box, left: number, top: number): BadgePos {
  const w = area.right - area.left;
  const h = area.bottom - area.top;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    fx: w > 0 ? round(clamp01((left - area.left) / w)) : 1,
    fy: h > 0 ? round(clamp01((top - area.top) / h)) : 1,
  };
}

export function isBadgePos(x: unknown): x is BadgePos {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return typeof p.fx === 'number' && typeof p.fy === 'number' && Number.isFinite(p.fx) && Number.isFinite(p.fy);
}

/** Accept whatever is in storage and return a clean map (bad entries dropped, values clamped). */
export function normalizeBadgePositions(raw: unknown): Record<string, BadgePos> {
  const out: Record<string, BadgePos> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = siteKey(k);
    if (key && isBadgePos(v)) out[key] = { fx: clamp01(v.fx), fy: clamp01(v.fy) };
  }
  return out;
}

/** Set (or with `null`, forget) the position for a site. Keeps at most MAX_BADGE_SITES, newest last. */
export function withBadgePosition(map: Record<string, BadgePos>, hostname: string, pos: BadgePos | null): Record<string, BadgePos> {
  const key = siteKey(hostname);
  const next = { ...map };
  delete next[key];
  if (pos && key) next[key] = { fx: clamp01(pos.fx), fy: clamp01(pos.fy) };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_BADGE_SITES))) delete next[k];
  return next;
}
