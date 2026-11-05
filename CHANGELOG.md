# Changelog

## Unreleased

- **Move GrammarMe's button** inside any text box by dragging it, like Grammarly's. The AI button
  moves with it, and the spot is remembered for each website. To undo it, open the toolbar menu
  and choose **Put it back in the corner**.
- Setup no longer waits forever when the ChatGPT permission is granted after the extension
  started. If it still can't reach the companion, the menu shows the real reason.

## 0.1.2 (2026-11-05)

**Easier ChatGPT setup**
- **One-line install** for the companion: `curl -fsSL https://bachnguyennn.github.io/GrammarMe/companion/install.sh | sh`.
  No Node.js, Git or source code needed. It checks every download against the release's checksums.
- **Standalone companion** with Node built in, for macOS (Apple silicon and Intel) and Linux (x64
  and arm64). People who already have Node.js 22.6+ get the small version instead.
- **Guided setup** in the extension's toolbar menu: step 1 shows the install line with a Copy
  button and moves on by itself once the companion is installed; step 2 is the ChatGPT sign-in.
- **GitHub Releases** now carry the extension zip, the companion builds and `SHA256SUMS`, all
  built in public by GitHub's build service from the tagged source.
- The install page has a three-step "Connect your ChatGPT plan" section.

## 0.1.1 (2026-11-05)

**Extension**
- Checks rich-text editors such as Gmail and Outlook on the web, not just plain text boxes.
  Quoted earlier messages are skipped.
- Optional **Check with ChatGPT**: grammar, clarity and tone edits using your own ChatGPT Plus or
  Pro plan, with no API key. It needs the GrammarMe companion on your computer (macOS or Linux).
  Setup: [docs/chatgpt.md](docs/chatgpt.md).
- Suggestion cards show highlighted words as code instead of raw backticks.
- "Open the web editor" now opens the hosted editor.
- The extension ID is now fixed (`cflaepodgccnfddlhomomhbmhgkgikhf`).
- Downloadable as a ready-to-load zip with a plain-English
  [install page](https://bachnguyennn.github.io/GrammarMe/install.html).

**Web editor**
- **Clear** and **Example** buttons. The logo links back to the home page.
- A new example paragraph whose mistakes the checker reliably catches.
- Clear loading, checking, "no suggestions" and "couldn't load" states, with a Try again button.
- On phones, suggestions sit right under the text, with a jump button.
- The optional AI settings say what is sent and link to a setup guide.

**Website**
- Real screenshots replace mock-ups of features that didn't exist.
- One consistent privacy statement, and no offline promise the editor can't keep.
- Extension expectations (desktop only, Developer mode, manual updates) shown beside the download.

**Updating the extension:** download the zip again, replace the old folder, then click the
reload arrow on GrammarMe's card in `chrome://extensions`. If you use the ChatGPT companion,
run `npm run install-host -w apps/companion` again.

## 0.1.0

First version: on-device spelling, grammar and punctuation checks (Harper), the web editor, the
Chrome extension for text boxes, the optional Cloudflare AI Worker, and the product website.
