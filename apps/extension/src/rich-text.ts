/**
 * Plain text out of a rich-text editor (contenteditable), plus the map back to the DOM.
 *
 * The checker works on a string; the page holds a tree of text nodes, <br>s and block elements.
 * `extractText` walks the editor once and returns the string Harper sees together with where every
 * character came from, so suggestion offsets can be turned into DOM Ranges (for underlines and
 * for applying a fix) and the caret can be turned back into an offset (for opening a card).
 *
 * Rules:
 * - Every text-node character maps 1:1 to one string character. No-break spaces, tabs and
 *   newlines inside text nodes become plain spaces, so offsets never shift.
 * - <br> and block boundaries (div, p, li, …) become "\n". These are "virtual" characters with no
 *   DOM position of their own.
 * - Quoted replies (Gmail's .gmail_quote, Outlook's #divRplyFwdMsg), contenteditable="false"
 *   islands (chips, embeds), hidden subtrees and opt-out subtrees are skipped: they're not the
 *   user's own writing.
 *
 * Only the DOM `Node` API subset below is used, so tests run it on plain objects.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'CANVAS', 'SELECT', 'TEXTAREA', 'INPUT', 'BUTTON']);
/** Quoted earlier messages and signatures-from-others in common mail clients. */
const QUOTE_CLASSES = ['gmail_quote', 'gmail_extra', 'protonmail_quote', 'yahoo_quoted', 'moz-cite-prefix'];
const QUOTE_IDS = ['divRplyFwdMsg', 'appendonsend'];

export interface TextSegment {
  node: Node;
  /** Offsets of this text node's characters in the extracted string. */
  start: number;
  end: number;
}

export interface TextMap {
  text: string;
  /** Text nodes in document order. */
  segments: TextSegment[];
  /** Extracted-string offset where each visited node starts / ends (elements and text nodes). */
  starts: Map<Node, number>;
  ends: Map<Node, number>;
}

export interface DomPoint {
  node: Node;
  offset: number;
}

function attr(node: Node, name: string): string | null {
  return (node as Element).getAttribute?.(name) ?? null;
}

function skipElement(node: Node): boolean {
  if (SKIP_TAGS.has(node.nodeName.toUpperCase())) return true;
  const ce = attr(node, 'contenteditable');
  if (ce !== null && ce.toLowerCase() === 'false') return true;
  if (attr(node, 'hidden') !== null || attr(node, 'aria-hidden') === 'true') return true;
  const opt = attr(node, 'data-grammarme') ?? '';
  if (opt === 'off' || opt === 'false' || attr(node, 'data-gramm') === 'false') return true;
  const cls = ` ${attr(node, 'class') ?? ''} `;
  if (QUOTE_CLASSES.some((c) => cls.includes(` ${c} `))) return true;
  const id = attr(node, 'id');
  return id !== null && QUOTE_IDS.includes(id);
}

export function extractText(root: Node): TextMap {
  let text = '';
  const segments: TextSegment[] = [];
  const starts = new Map<Node, number>();
  const ends = new Map<Node, number>();
  const newline = () => {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  };

  const visit = (node: Node, isRoot: boolean): void => {
    starts.set(node, text.length);
    if (node.nodeType === TEXT_NODE) {
      const data = (node as Text).data ?? '';
      const start = text.length;
      text += data.replace(/[ \t\n\r\f\v]/g, ' ');
      segments.push({ node, start, end: text.length });
    } else if (node.nodeType === ELEMENT_NODE) {
      const name = node.nodeName.toUpperCase();
      if (!isRoot && skipElement(node)) {
        // A skipped block still separates the text around it.
        if (BLOCK.has(name)) newline();
      } else if (name === 'BR') {
        text += '\n';
      } else {
        const block = !isRoot && BLOCK.has(name);
        if (block) newline();
        const kids = node.childNodes;
        for (let i = 0; i < kids.length; i++) visit(kids[i]!, false);
        if (block) newline();
      }
    }
    ends.set(node, text.length);
  };
  visit(root, true);
  // Trailing line breaks are virtual (no DOM text); drop them so the text ends where the writing does.
  text = text.replace(/\n+$/, '');
  return { text, segments, starts, ends };
}

/** Index of the last segment whose start is <= offset (segments are sorted). */
function segmentIndexAt(segments: readonly TextSegment[], offset: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * DOM position for a string offset. `bias` decides boundaries between nodes: 'forward' (a range
 * start) lands at the beginning of the next text node, 'backward' (a range end) at the end of the
 * previous one, so a range never starts or ends inside a neighbour it doesn't cover. Offsets on a
 * virtual "\n" snap to the nearest text in the bias direction. Null when there's no text at all.
 */
export function domPointAt(map: TextMap, offset: number, bias: 'forward' | 'backward'): DomPoint | null {
  const segs = map.segments;
  if (!segs.length) return null;
  let i = segmentIndexAt(segs, offset);
  if (bias === 'forward') {
    // Prefer a segment that still has characters at `offset`.
    if (i < 0 || offset >= segs[i]!.end) {
      const next = segs.findIndex((s, k) => k > i && s.end > s.start && s.start >= offset);
      if (next >= 0) return { node: segs[next]!.node, offset: 0 };
      if (i < 0) i = 0;
    }
  } else {
    // Walk back to a segment that ends at or after `offset` and starts before it.
    while (i > 0 && segs[i]!.start === offset && segs[i - 1]!.end >= offset) i--;
    if (i < 0) return { node: segs[0]!.node, offset: 0 };
  }
  const s = segs[i]!;
  return { node: s.node, offset: Math.max(0, Math.min(offset, s.end) - s.start) };
}

/** String offset for a DOM position (e.g. the caret), or null if it's outside the mapped text. */
export function offsetAtDom(map: TextMap, node: Node, offset: number): number | null {
  if (node.nodeType === TEXT_NODE) {
    const start = map.starts.get(node);
    const end = map.ends.get(node);
    if (start === undefined || end === undefined) return null;
    return Math.min(start + offset, end, map.text.length);
  }
  const kids = node.childNodes;
  const at = offset < kids.length ? (map.starts.get(kids[offset]!) ?? map.starts.get(node)) : map.ends.get(node);
  return at === undefined ? null : Math.min(at, map.text.length);
}
