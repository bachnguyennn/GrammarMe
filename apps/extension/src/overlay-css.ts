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
.u.correctness { text-decoration-color: #d93f3f; --gm-mark: #d93f3f; }
.u.clarity { text-decoration-color: #2f6fdb; --gm-mark: #2f6fdb; }
.u.style { text-decoration-color: #7b4fd0; --gm-mark: #7b4fd0; }
.u.active.correctness { background: rgba(217, 63, 63, 0.18); }
.u.active.clarity { background: rgba(47, 111, 219, 0.18); }
.u.active.style { background: rgba(123, 79, 208, 0.18); }
.u.insert { position: relative; }
.u.insert::before {
  content: ""; position: absolute; left: -1px; top: 0.1em; height: 1.1em; width: 2px;
  background: var(--gm-mark);
}
.badge {
  position: fixed; z-index: 2; box-sizing: border-box; width: 20px; height: 20px; min-width: 20px;
  margin: 0; padding: 0 4px; border: 0; border-radius: 10px; cursor: pointer;
  font: 700 11px/20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center;
  color: #fff; background: #1f7a5c; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  opacity: 0.92; transition: opacity 120ms;
}
.badge:hover { opacity: 1; }
.badge.issues { background: #d93f3f; }
.badge.muted { background: #6b7280; }
.badge:focus-visible { outline: 2px solid #1f7a5c; outline-offset: 2px; }
.card {
  --bg: #ffffff; --fg: #1f2328; --sub: #57606a; --line: #d0d7de; --btn: #f3f4f6; --btn-hover: #e5e7eb;
  --accent: #1f7a5c; --accent-fg: #ffffff;
  position: fixed; z-index: 3; box-sizing: border-box; width: max-content; max-width: min(340px, calc(100vw - 16px));
  min-width: 220px; padding: 10px 12px 10px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg); color: var(--fg); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
}
@media (prefers-color-scheme: dark) {
  .card {
    --bg: #1f2428; --fg: #e6edf3; --sub: #9da7b3; --line: #3d444d; --btn: #2d333b; --btn-hover: #373e47;
    --accent: #3fa37f; --accent-fg: #0d1117;
  }
}
.head { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.correctness { background: #d93f3f; } .dot.clarity { background: #2f6fdb; } .dot.style { background: #7b4fd0; }
.cat { font-weight: 600; font-size: 12px; color: var(--sub); text-transform: uppercase; letter-spacing: 0.04em; flex: 1; }
.close {
  all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px; text-align: center;
  line-height: 22px; font-size: 16px; color: var(--sub);
}
.close:hover { background: var(--btn); }
.msg { margin: 0 0 8px; overflow-wrap: anywhere; }
.repls { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.repl {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 3px 10px; border-radius: 6px;
  background: var(--accent); color: var(--accent-fg); font-weight: 600; white-space: pre; max-width: 100%;
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
