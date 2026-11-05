# Changelog

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
