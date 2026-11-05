/** Styles for the Shadow-DOM UI (adopted via CSSStyleSheet, so page CSP `style-src` can't block it). */
export const OVERLAY_CSS = `
:host { all: initial; }
.mirror {
  position: fixed; margin: 0; box-sizing: border-box; overflow: hidden;
  border-style: solid; border-color: transparent; background: transparent;
  color: transparent; -webkit-text-fill-color: transparent;
  pointer-events: none; user-select: none; z-index: 1;
}
.u {
  text-decoration-line: underline; text-decoration-style: wavy; text-decoration-thickness: 1.5px;
  text-underline-offset: 3px; text-decoration-skip-ink: none; border-radius: 2px;
}
.u.correctness { text-decoration-color: #c8453d; --gm-mark: #c8453d; }
.u.clarity { text-decoration-color: #2d68c4; --gm-mark: #2d68c4; }
.u.style { text-decoration-color: #a86b12; --gm-mark: #a86b12; }
.u.active.correctness { background: rgba(217, 63, 63, 0.18); }
.u.active.clarity { background: rgba(47, 111, 219, 0.18); }
.u.active.style { background: rgba(168, 107, 18, 0.18); }
.u.insert { position: relative; }
.u.insert::before {
  content: ""; position: absolute; left: -1px; top: 0.1em; height: 1.1em; width: 2px;
  background: var(--gm-mark);
}
.lines { position: fixed; inset: 0; pointer-events: none; z-index: 1; }
.bar, .hl { position: fixed; pointer-events: none; border-radius: 1px; }
.bar.correctness { background: #c8453d; } .bar.clarity { background: #2d68c4; } .bar.style { background: #a86b12; }
.bar:not(.insert) { opacity: 0.85; }
.hl { border-radius: 2px; }
.hl.correctness { background: rgba(217, 63, 63, 0.18); }
.hl.clarity { background: rgba(47, 111, 219, 0.18); }
.hl.style { background: rgba(168, 107, 18, 0.18); }
.badge {
  position: fixed; z-index: 2; box-sizing: border-box; width: 20px; height: 20px; min-width: 20px;
  margin: 0; padding: 0 4px; border: 0; border-radius: 10px; cursor: pointer;
  font: 500 11px/20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center;
  color: #fff; background: #5c6b54; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  opacity: 0.92; transition: opacity 120ms;
}
.badge:hover { opacity: 1; }
.badge.issues { background: #c8453d; }
.badge.muted { background: #6f6b67; }
.badge:focus-visible { outline: 2px solid #5c6b54; outline-offset: 2px; }
.card {
  --bg: #ffffff; --fg: #333231; --sub: #625f5b; --line: #dcd8d3; --btn: #eeecea; --btn-hover: #e4e1dd;
  --accent: #5c6b54; --accent-fg: #ffffff;
  position: fixed; z-index: 3; box-sizing: border-box; width: max-content; max-width: min(340px, calc(100vw - 16px));
  min-width: 220px; padding: 10px 12px 10px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg); color: var(--fg); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
}
@media (prefers-color-scheme: dark) {
  .card {
    --bg: #333231; --fg: #eeecea; --sub: #adaba9; --line: #55524d; --btn: #3e3d3c; --btn-hover: #45433f;
    --accent: #a9bca0; --accent-fg: #1f241c;
  }
}
.head { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.correctness { background: #c8453d; } .dot.clarity { background: #2d68c4; } .dot.style { background: #a86b12; }
.cat { font-weight: 500; font-size: 12px; color: var(--sub); flex: 1; }
.close {
  all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px; text-align: center;
  line-height: 22px; font-size: 16px; color: var(--sub);
}
.close:hover { background: var(--btn); }
.msg { margin: 0 0 8px; overflow-wrap: anywhere; }
.repls { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.repl {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 3px 10px; border-radius: 6px;
  background: var(--accent); color: var(--accent-fg); font-weight: 500; white-space: pre; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis;
}
.repl:hover { filter: brightness(1.08); }
.foot { display: flex; gap: 6px; border-top: 1px solid var(--line); padding-top: 8px; }
.action {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 3px 8px; border-radius: 6px;
  background: var(--btn); color: var(--fg); font-size: 12px;
}
.action:hover { background: var(--btn-hover); }
.repl:focus-visible, .action:focus-visible, .close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
`;
