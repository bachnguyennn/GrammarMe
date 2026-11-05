# Connect your ChatGPT plan (optional)

GrammarMe's spelling and grammar checks run on your device and need nothing from this page. This
guide is for the **optional** "Check with ChatGPT" feature in the **Chrome extension**. It asks
ChatGPT for grammar, clarity or tone edits on text you choose. It uses **your own ChatGPT plan**
through OpenAI's official
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) flow, with
**no OpenAI API key**.

> **Before you start: you need a small companion program.** OpenAI's sign-in for local apps
> finishes on a web address on your own computer (`http://127.0.0.1:…`). A browser extension
> can't receive that address, so GrammarMe uses a companion program for the sign-in. The
> companion also keeps your ChatGPT credentials on your disk, never in the browser. Chrome
> starts it only when needed. Installing it takes one terminal command.

## Who can use it

From OpenAI's documentation, checked on **2026-11-05**:

- **Plans:** OpenAI lists **eligible ChatGPT Plus and Pro users**. Free, Business/Team,
  Enterprise and Edu plans aren't listed, and OpenAI may reject them. Some regions may not be
  supported. GrammarMe shows OpenAI's answer if your account isn't eligible.
- **Which apps it's for:** OpenAI says plan usage is "available for open-source tools and personal
  projects that run locally". GrammarMe is open source and the companion runs on your computer.
  OpenAI's pages don't mention browser extensions specifically.
- **Where it works:** only in the extension, with the companion installed. The hosted web editor
  on GitHub Pages doesn't offer it. A remotely hosted app would need OpenAI's approval, which
  this project doesn't have.
- **Billing:** requests use your plan's included usage. GrammarMe never asks for an API key,
  never switches to API billing, and never sends your text to another provider. When you reach
  your plan's limit, AI checks stop until it resets, and local checks keep working. OpenAI may
  apply its own plan limits or charges. See
  [ChatGPT settings → Usage](https://chatgpt.com/settings/usage).

## What you need

- macOS or Linux. Windows isn't supported by the companion yet.
- [Node.js](https://nodejs.org) 22.6 or newer.
- Google Chrome, Chromium, Microsoft Edge or Brave, with the GrammarMe extension installed, either
  from the [download](https://bachnguyennn.github.io/GrammarMe/install.html) or from source.
  The extension's ID is fixed (`cflaepodgccnfddlhomomhbmhgkgikhf`), and the companion only
  answers that ID.
- A ChatGPT Plus or Pro account.

## 1. Install the companion

```sh
git clone https://github.com/bachnguyennn/GrammarMe.git
cd GrammarMe
npm install
npm run install-host -w apps/companion
```

This builds the companion and copies it to `~/.config/grammarme/bin/`, outside the checkout, so
macOS doesn't ask Chrome for folder access. It then registers it with each installed Chromium
browser as the native messaging host `com.grammarme.chatgpt`, allowed for GrammarMe's extension ID
only. Run the same command again after you update GrammarMe. To check the setup:

```sh
node apps/companion/dist/grammarme-companion.mjs doctor
```

There's nothing to start or keep running. Chrome launches the companion when the extension
needs it, and it exits when the extension disconnects, usually within seconds.

## 2. Connect

1. Click GrammarMe in Chrome's toolbar. If you don't see it, pin it from the puzzle-piece menu.
2. Under **ChatGPT suggestions**, click **Continue with ChatGPT**.
3. Chrome asks whether GrammarMe may "communicate with cooperating native applications". That
   permission is for the companion. Allow it.
4. A tab opens on **auth.openai.com**. Sign in and allow GrammarMe to **use your ChatGPT plan**.
   If you decline plan usage, GrammarMe shows "plan usage wasn't allowed" and sends nothing.
5. The tab says you can close it. Open GrammarMe's toolbar menu again: it shows **Connected as
   you@example.com · Using ChatGPT plan**. The first time, it also shows OpenAI's notice "You're
   using your ChatGPT plan".
6. Optional: pick a **model** from your account's list, and press **Test connection**. That sends
   one tiny request and uses a small amount of your allowance.

## 3. Check text with ChatGPT

1. Click into a text box on a website and type. Local underlines appear as usual.
2. A small teal **AI** button sits next to GrammarMe's badge. Select the part you want checked
   first, or check:
   - **everything in the box**, when it's 4,000 characters or fewer
   - **the paragraph around your cursor**, when the box holds more than that
3. Choose **Grammar**, **Clarity** or **Tone**. The panel shows the **exact text that will be
   sent** and says it goes to OpenAI.
4. Press **Send to ChatGPT**, or **Cancel** at any time while it's checking.
5. Suggested edits appear as underlines marked **· ChatGPT**. Click one to see the reason, then
   accept or dismiss it. Cmd/Ctrl+Z undoes an accepted edit, as with any typing.

Nothing is sent while you type, and one box can have only one check running at a time.

## What is sent, where it goes, what is stored

| What | Where |
| --- | --- |
| Spelling and grammar checks | Your device only (Harper). Unchanged by this feature. |
| Text you send with **Send to ChatGPT** (the previewed text, ≤ 4,000 characters) and the check type | Extension → companion on your computer → `https://api.openai.com/v1/responses`, with `store: false` |
| Sign-in | Your browser ↔ `auth.openai.com`; the result returns to the companion at `http://127.0.0.1:<port>/auth/callback` |
| ChatGPT credentials (access, refresh and ID tokens) | Only in the companion's file `~/.config/grammarme/chatgpt.json` (or `$XDG_CONFIG_HOME/grammarme/`), created with owner-only permissions (`0600`). Never in the extension, web pages, messages, logs or this repository |
| Chosen model, a random install ID, the app ID OpenAI issued | The same file |
| "ChatGPT is connected" flag, "notice seen" flag | `chrome.storage.local` (no secrets) |

The companion only knows a fixed set of operations: status, sign in, sign out, list models,
choose model, test and check. It won't fetch other URLs or forward arbitrary requests.

## Disconnect and delete credentials

- **Extension:** toolbar menu → **Disconnect**. The companion asks OpenAI to revoke the session,
  then deletes the access, refresh and ID tokens from disk. If OpenAI can't be reached, it still
  deletes them locally and tells you.
- **Terminal:** `node apps/companion/dist/grammarme-companion.mjs sign-out`.
- **ChatGPT:** you can also remove GrammarMe in your ChatGPT settings. OpenAI doesn't notify apps
  about this, so GrammarMe finds out at the next check and asks you to connect again.
- **Remove the companion:** `node apps/companion/dist/grammarme-companion.mjs uninstall`, which
  removes the browser registrations and `~/.config/grammarme/bin`. Then
  delete `~/.config/grammarme/` if you want the install ID gone too.

## Troubleshooting

| You see | Cause and fix |
| --- | --- |
| "Companion not found" | The companion isn't registered. Run `npm run install-host -w apps/companion`, then press **Check again**. |
| "installed for a different extension ID" | The companion only allows `cflaepodgccnfddlhomomhbmhgkgikhf`. Check the ID on `chrome://extensions`. If you changed `manifest.json`'s `key`, re-run the installer with `--extension-id <id>`. |
| "The connection … was interrupted" | The companion exited, often because Node moved after an upgrade. Re-run the installer, then `doctor`. |
| Sign-in tab shows an error or never finishes | Something may block `127.0.0.1` callbacks (a firewall or VPN). Retry, or cancel and try again. Sign-in expires after 10 minutes. |
| "plan usage wasn't allowed" | You declined the plan-usage permission. Connect again and allow it. |
| "isn't eligible" | OpenAI says this account or region can't use its plan in other apps. Plus or Pro is required. |
| "reached your ChatGPT plan's usage limit" | Wait for it to reset ([Manage usage](https://chatgpt.com/settings/usage)). Local checks keep working. |
| "That model isn't available" | Pick another model in the toolbar menu. |
| "connection has expired or was removed" | Connect again. Refresh tokens last 30 days and renew with use. |

`doctor` checks Node, the host registration, the allowed extension IDs, the credentials file's
permissions (it never prints tokens) and whether `auth.openai.com` is reachable.

## Limitations

- **Companion:** macOS and Linux only for now. Windows needs a registry-based install that isn't
  written yet.
- **Not on the hosted web editor:** it doesn't offer ChatGPT. Its optional AI still works through
  your own server ([AI setup](ai-setup.md)).
- **Chrome's built-in pages:** the extension, and so ChatGPT checks, can't run on the Chrome Web
  Store or browser pages, or in editors inside iframes and Google Docs.
- **No guarantees from the guards:** they reject edits that look unsafe (ambiguous quotes,
  overlaps, changed names, numbers, URLs, code or negations, edits that are too large). They can’t guarantee an
  edit keeps your meaning, so review each edit before accepting it.
- **OpenAI may change the protocol:** Sign in with ChatGPT is new, and OpenAI may change models,
  limits or eligibility.

How it's built: [architecture](architecture.md#optional-chatgpt-companion) ·
[companion README](../apps/companion/README.md).
