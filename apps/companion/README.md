# GrammarMe ChatGPT companion

A small local Node.js program that lets the GrammarMe Chrome extension run AI writing checks
on **your own ChatGPT plan**. It uses OpenAI's official *Sign in with ChatGPT* flow for local
apps. Chrome starts it through
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
only when GrammarMe needs it.

## Why it exists

- **Sign in with ChatGPT needs a local loopback callback.** OpenAI sends the browser back to
  `http://127.0.0.1:<port>/auth/callback` after you consent. A Chrome extension can't listen on a
  local port, but this program can.
- **Your credentials stay on disk, not in the browser.** The OAuth access, refresh and ID tokens
  live in one private file (`chatgpt.json`, mode 0600) that only this program reads. The
  extension never receives a token. It can only ask for fixed operations (status, sign in or
  out, list or choose a model, test, check text). The message contract is in
  [`packages/core/src/companion.ts`](../../packages/core/src/companion.ts).
- **Checks use your plan, not a GrammarMe server.** Text goes from your machine straight to
  `https://api.openai.com/v1/responses` with `store: false`. OpenAI's usage limits for your plan
  apply. When you hit a limit, GrammarMe tells you and keeps doing local checks. It never falls
  back to another provider or billing path.

## Requirements

- macOS or Linux. **Windows isn't supported yet**, because native messaging hosts there are
  registered in the Windows registry.
- Node.js 22.6 or newer.
- Chrome, Chromium, Microsoft Edge or Brave.
- A ChatGPT plan that OpenAI allows to be used in other apps.

## Install

From the repository root:

```sh
npm install
npm run install-host -w apps/companion
```

This builds `apps/companion/dist/grammarme-companion.mjs` and then runs `install`, which:

1. Copies the bundle to `~/.config/grammarme/bin/grammarme-companion.mjs` (or
   `$XDG_CONFIG_HOME/grammarme/bin/`), and writes the launcher `grammarme-companion-host.sh` next
   to it. The launcher runs the exact Node binary you installed with (`process.execPath`), so it
   doesn't depend on Chrome's `PATH`. Running a copy outside the checkout means macOS never asks
   Chrome for access to `~/Documents` or `~/Desktop`, and moving or deleting the checkout doesn't
   break it. Re-run `install` after pulling updates.
2. Writes the host manifest `com.grammarme.chatgpt.json` into the `NativeMessagingHosts` folder
   of each browser that has a profile on this machine:

   | Browser  | macOS (`~/Library/Application Support/…`) | Linux (`~/.config/…`)          |
   | -------- | ----------------------------------------- | ------------------------------ |
   | Chrome   | `Google/Chrome/NativeMessagingHosts`      | `google-chrome/NativeMessagingHosts` |
   | Chromium | `Chromium/NativeMessagingHosts`           | `chromium/NativeMessagingHosts` |
   | Edge     | `Microsoft Edge/NativeMessagingHosts`     | `microsoft-edge/NativeMessagingHosts` |
   | Brave    | `BraveSoftware/Brave-Browser/NativeMessagingHosts` | `BraveSoftware/Brave-Browser/NativeMessagingHosts` |

If you load the extension unpacked, it has a different ID. Pass that ID (shown on
`chrome://extensions`) so Chrome lets it connect:

```sh
node apps/companion/dist/grammarme-companion.mjs install --extension-id <your-extension-id>
```

### CLI

```text
grammarme-companion install [--extension-id <id>]... [--browser chrome|chromium|edge|brave|all]... [--manifest-dir <dir>]...
grammarme-companion uninstall [--manifest-dir <dir>]...
grammarme-companion doctor      # health report (never prints tokens)
grammarme-companion status      # connected? account, plan permission, model
grammarme-companion sign-in     # connect from the terminal (prints and opens the OpenAI page)
grammarme-companion sign-out    # revoke at OpenAI, then delete local tokens
grammarme-companion --version
```

- `--browser` installs for that browser even if it has no profile yet. `all` installs for every
  browser in the table above.
- `--manifest-dir` installs only into the given folder, for example a temporary Chrome profile's
  `NativeMessagingHosts`. Tests and the end-to-end harness use it.

## Start and stop

You don't start it yourself. When the extension calls `chrome.runtime.connectNative`, Chrome
starts the launcher with the extension's origin as its argument. The companion exits when the
extension disconnects (stdin closes), and any check or sign-in still running is cancelled first.
Chrome can start more than one copy. They share the credential file safely through a lock file.

To remove the companion:

```sh
node apps/companion/dist/grammarme-companion.mjs sign-out    # optional: revoke and delete tokens
node apps/companion/dist/grammarme-companion.mjs uninstall
```

`uninstall` removes the manifests, the launcher and host copy in `~/.config/grammarme/bin`, and
`allowed-origins.json`. With
`--manifest-dir`, it removes only the manifest in that folder and leaves the rest of the install
alone. It keeps your credentials, so run `sign-out` first if you want those gone. You can also delete the
`~/.config/grammarme` folder.

## Where data lives

`$GRAMMARME_COMPANION_HOME`, otherwise `$XDG_CONFIG_HOME/grammarme`, otherwise
`~/.config/grammarme`. This is the same on macOS and Linux.

| File                   | Contents                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `chatgpt.json` (0600)  | Host ID, the client ID OpenAI issued, the profile (email and name, for display only), the access, refresh and ID tokens with expiry and granted scope, and the chosen model |
| `allowed-origins.json` | Extension IDs allowed to start the companion                             |

The folder is 0700. Every write goes to a 0600 temp file first and is then renamed into place.
On Windows (not yet supported) the profile's default permissions would apply.

## Troubleshooting

Start with `node apps/companion/dist/grammarme-companion.mjs doctor`. It shows the Node version,
the launcher and the Node binary it points to, each browser's manifest and allowed origins, the
credential file's permissions, and whether `auth.openai.com` is reachable.

- **"Specified native messaging host not found."** The manifest isn't installed for this browser
  or profile. Run `install` again, adding `--browser <name>` if your browser had no profile when
  you first installed. Then reload the extension.
- **"Access to the specified native messaging host is forbidden."** The extension's ID isn't in
  the manifest's `allowed_origins`. This is usual for unpacked builds. Run
  `install --extension-id <id>` with the ID from `chrome://extensions`. The companion also checks
  the caller against `allowed-origins.json` and exits if the ID isn't listed.
- **"Native host has exited." right away, or doctor says the Node binary is missing.** Node moved
  or was upgraded (for example by nvm), or the repository moved. Run `install` again.
- **macOS asks whether Chrome may access a folder.** This shouldn't happen, because `install`
  copies the companion to `~/.config/grammarme/bin`. If it does, you're running an install from an
  older version. Run `install` again.
- **Sign-in never finishes.** The browser must reach `http://127.0.0.1:<port>/auth/callback`. The
  companion tries port 1455 first, then any free port. A firewall or proxy that intercepts
  loopback traffic will block this. Sign-in gives up after 10 minutes.
- **"Your ChatGPT connection has expired or was removed."** You disconnected GrammarMe in
  ChatGPT's settings, or the refresh token expired. OpenAI doesn't notify apps when this happens,
  so the next request fails. Connect again.

## Security notes

- Only OpenAI's documented Sign in with ChatGPT endpoints (found through
  `https://auth.openai.com/.well-known/openid-configuration`) and `api.openai.com/v1/responses`
  and `/v1/models` are called. It never calls ChatGPT `backend-api` endpoints.
- PKCE S256 is used, with a fresh `state` and `nonce` for every attempt. The loopback listener
  binds to 127.0.0.1 only, answers only `GET /auth/callback`, checks the `Host` header, and closes
  after one callback.
- The ID token's signature is checked against OpenAI's JWKS, along with `iss`, `aud` (the issued
  client ID), `exp`, `iat`, `nonce` and `sub`. Plan usage is allowed **only** when the granted
  scope includes `chatgpt.tokens.use.direct`. A valid identity on its own isn't enough.
- Refresh tokens rotate, and the newest one is always saved. Refreshes are serialized in each
  process and across processes. If OpenAI rejects a refresh token, the tokens are deleted and you
  are asked to connect again.
- Tokens never appear in URLs, logs or messages to the extension. stdout carries only native
  messaging frames. stderr gets short event names and error codes, never text or tokens.
- No runtime npm dependencies: the bundle uses only Node built-ins.

## Test hooks

These exist only for automated tests:

- `GRAMMARME_COMPANION_TEST_AUTH_ORIGIN` replaces `https://auth.openai.com`.
- `GRAMMARME_COMPANION_TEST_API_ORIGIN` replaces `https://api.openai.com`.

Both accept only a URL whose host is `127.0.0.1` or `localhost`, and the companion refuses to
start with any other value. While the auth hook is set, discovered endpoints must also be loopback.
`GRAMMARME_COMPANION_HOME` moves the data folder.
`GRAMMARME_COMPANION_OPEN_BROWSER=1` makes the host open the authorize URL itself. Normally the
extension opens it.

## Development

```sh
npm run typecheck -w apps/companion
npm run test -w apps/companion     # vitest; all network is mocked or on 127.0.0.1
npm run build -w apps/companion    # esbuild → dist/grammarme-companion.mjs
```

Source layout: `src/cli.ts` (entry point and CLI), `host.ts` (native messaging loop),
`companion.ts` (operations), `oauth.ts` and `oidc.ts` (Sign in with ChatGPT), `loopback.ts`
(callback listener), `openai.ts` and `sse.ts` (Responses API streaming and models), `store.ts`
(credential file and lock), `install.ts` and `doctor.ts`. Prompts and output guards come from
`@grammarme/core/ai`, the same ones the Cloudflare Worker uses.
