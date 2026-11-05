# Product site — design report (taste-skill 2.5.0)

Built with [taste-skill](https://github.com/leonxlnx/taste-skill) (MIT; kit assets in
`apps/site/assets`, licence in `apps/site/assets/LICENSE-taste-skill`). Checked on 2026-11-04 with
the skill's own scripts in headless Chrome.

## Kind and deal

- **Kind:** software (`data-type="software"`, `site-kind` software).
- **Dealt by the scripts:**
  - Hero: `centred`. Palette: three stones. Type: Reddit Sans and JetBrains Mono. Radius: round.
    Lit ground: sage.
  - Nav: `nav-mega`. Close: `close-type`. Footer: `footer-dark`. Rhythm: `dark-band` (the
    extension section). Buttons: `arrow`. Mark: `stack`.
  - Effect: `gradient-mesh` in the hero window. Card ground: `painterly-landscape` on the feature
    cards. Moments: none (0 to 2 allowed). Scene: none.
- **Plan, in screens:** hero 1 · editor (`app-frame`) 1 · checks (`features-2x2`) 2 ·
  extension (`split-text-left` on the dark band) 1 · questions (`faq`) 1 · footer.closing 1.

## Results

| Check | Result |
| --- | --- |
| `layout/check.mjs` at 1440, 1024, 820, 768, 390 | **no findings** |
| `perf.mjs` | **0 FAIL**, 4 WARN. 258 KiB transferred, 2 WebGL contexts at peak, LCP 116 ms (CPU-relative) |
| `consistency.mjs` at the same five widths | 26 FAIL, 49 WARN, down from 68 FAIL. Every remaining FAIL is listed below |

### Remaining consistency FAILs, judged and kept

- **21 × `container-edges` on the hero h1, lead and pill.** The dealt hero is `centred`, and
  `layout-v4.md` §4 names it as "the one exception, on the page axis". Re-dealing to a left-set
  hero would go against the deal.
- **2 × `cut-text` in the diagram card at 1024 and 390.** The kit's `diagram.js` draws lane
  captions wider than their tiles at narrow card widths. The skill says not to edit kit files, so
  it is reported here instead.
- **3 × `section-gaps` next to the two-screen features section at 1024, 820 and 390.** The
  second screen of `features-2x2` ends with more air than the other sections. Pinning the panels
  to one `--p-h` (cards.md) is what causes it.

## Assumptions and honesty notes

- **No prices, addresses, phone numbers or people.** Contact goes through GitHub issues.
- **Every mistake shown in a mock-up is one GrammarMe really flags.** Each was run through
  `HarperEngine` first.
- **Accuracy figures come from `docs/evaluation.md`:** recall 69.5%, shown as 70%; precision
  84.0%, shown as 84%. The answer links to the method.
- **No photographs,** so there is no credits line. One trademark line covers the Chrome icon.
- **Not checked:**
  - A real Chrome Web Store listing: the extension is installed unpacked, and the copy says
    "Read the install steps".
  - How the site looks in Safari and Firefox.
