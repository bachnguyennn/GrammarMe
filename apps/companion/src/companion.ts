/**
 * The companion's operations, shared by the native messaging host and the terminal CLI.
 * Every OAuth credential stays inside this process and the 0600 credential file.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AI_CHECK_TIMEOUT_MS, AI_MAX_EDITS, AI_MAX_OUTPUT_CHARS, COMPANION_PROTOCOL, SIGN_IN_TIMEOUT_MS } from '@grammarme/core/companion';
import type { CheckPayload, ModelInfo, StatusPayload } from '@grammarme/core/companion';
import { buildSystemPrompt, buildUserPrompt, extractEditList, sanitizeEdits } from '@grammarme/core/ai';
import type { AiTask, WritingMode } from '@grammarme/core';
import { PREFERRED_CALLBACK_PORT, resolveEndpoints } from './config.ts';
import type { Endpoints } from './config.ts';
import { CompanionError, UnauthorizedError } from './errors.ts';
import type { FetchFn } from './http.ts';
import { startCallbackServer } from './loopback.ts';
import { scopeFromAccessToken, buildAuthorizeUrl, createPkce, exchangeCode, hasPlanScope, parseCallback, randomUrlToken, refreshGrant, revokeRefreshToken } from './oauth.ts';
import { OidcClient } from './oidc.ts';
import { fetchModels, parseModelJson, streamResponse } from './openai.ts';
import { CredentialStore } from './store.ts';
import type { CredentialFile, StoredTokens } from './store.ts';
import { COMPANION_VERSION } from './version.ts';

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 20_000;

export interface CompanionOptions {
  /** Directory holding chatgpt.json (see companionHome()). */
  home: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFn;
  now?: () => number;
  /** Loopback port tried first (default 1455; 0 = always random). */
  preferredCallbackPort?: number;
  checkTimeoutMs?: number;
  signInTimeoutMs?: number;
  revokeBackoffMs?: number;
  /** Opens the authorize URL. Default: only when GRAMMARME_COMPANION_OPEN_BROWSER=1. */
  openBrowser?: (url: string) => void;
}

export interface CheckInput {
  task: AiTask;
  mode: WritingMode;
  text: string;
}

export function needsRefresh(tokens: StoredTokens, now: number): boolean {
  const left = tokens.expiresAt - now;
  if (left >= REFRESH_MARGIN_MS) return false;
  // OpenAI may ask us to wait; honour it while the current token is still valid.
  if (tokens.earliestRefreshAt !== undefined && now < tokens.earliestRefreshAt && left > 0) return false;
  return true;
}

/** Opens a URL in the default browser without a shell. */
export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL was also sent to the extension, which opens it.
  }
}

function withoutTokens(cur: CredentialFile): CredentialFile {
  const { tokens: _tokens, ...rest } = cur;
  return rest;
}

export class Companion {
  readonly store: CredentialStore;
  readonly endpoints: Endpoints;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly oidc: OidcClient;
  private readonly options: CompanionOptions;
  private refreshing: Promise<string> | undefined;
  private modelCache: ModelInfo[] | undefined;

  constructor(options: CompanionOptions) {
    this.options = options;
    this.store = new CredentialStore(options.home);
    this.endpoints = resolveEndpoints(options.env ?? process.env);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.oidc = new OidcClient(this.endpoints, this.fetchFn);
  }

  /* -------------------------------------------------------------- status */

  async status(): Promise<StatusPayload> {
    return this.statusFrom(await this.store.read());
  }

  private statusFrom(cur: CredentialFile): StatusPayload {
    const status: StatusPayload = { protocol: COMPANION_PROTOCOL, companionVersion: COMPANION_VERSION, connected: Boolean(cur.tokens) };
    if (cur.tokens) {
      status.account = { planUsage: hasPlanScope(cur.tokens.scope) };
      if (cur.profile?.email) status.account.email = cur.profile.email;
      if (cur.profile?.name) status.account.name = cur.profile.name;
    }
    if (cur.model) status.model = cur.model;
    return status;
  }

  /* -------------------------------------------------------------- sign in / out */

  /**
   * Runs the loopback authorization-code flow. `onAuthUrl` receives OpenAI's authorize URL once the
   * listener is up; the extension opens it. Resolves with the new status, or throws.
   */
  async signIn(onAuthUrl: (url: string) => void, signal: AbortSignal): Promise<StatusPayload> {
    const discovery = await this.oidc.discovery(signal);
    const saved = await this.store.update((cur) => (cur.hostId ? cur : { ...cur, hostId: `urn:uuid:${randomUUID()}` }));
    const pkce = createPkce();
    const state = randomUrlToken(24);
    const nonce = randomUrlToken(24);

    const server = await startCallbackServer({ expectedState: state, preferredPort: this.options.preferredCallbackPort ?? PREFERRED_CALLBACK_PORT });
    let params: URLSearchParams;
    try {
      const url = buildAuthorizeUrl({
        authorizationEndpoint: discovery.authorizationEndpoint,
        ...(saved.clientId ? { issuedClientId: saved.clientId } : {}),
        ...(saved.clientId && saved.tokens?.id ? { idTokenHint: saved.tokens.id } : {}),
        hostId: saved.hostId as string,
        redirectUri: server.redirectUri,
        state,
        nonce,
        codeChallenge: pkce.challenge,
      });
      onAuthUrl(url);
      const open = this.options.openBrowser ?? ((this.options.env ?? process.env).GRAMMARME_COMPANION_OPEN_BROWSER === '1' ? openInBrowser : undefined);
      open?.(url);
      params = await this.waitForCallback(server.result, signal);
    } finally {
      await server.close();
    }

    const callback = parseCallback(params, state);
    if (!callback.ok) throw new CompanionError(callback.error, callback.message);
    const clientId = callback.clientId ?? saved.clientId;
    if (!clientId) throw new CompanionError('provider_error', 'OpenAI didn’t return a client ID for this install.');

    const tokens = await exchangeCode(
      this.fetchFn,
      discovery.tokenEndpoint,
      { clientId, code: callback.code, codeVerifier: pkce.verifier, redirectUri: server.redirectUri, now: this.now() },
      signal,
    );
    if (!tokens.refreshToken || !tokens.idToken) {
      throw new CompanionError('provider_error', 'OpenAI’s token response was incomplete.');
    }
    const claims = await this.oidc.verifyIdToken(tokens.idToken, { clientId, nonce, now: this.now() }, signal);
    const scope = tokens.scope ?? scopeFromAccessToken(tokens.accessToken) ?? '';

    const next = await this.store.update((cur) => {
      const sameUser = cur.profile?.sub === claims.sub;
      const out: CredentialFile = {
        ...cur,
        clientId,
        profile: claims,
        tokens: {
          access: tokens.accessToken,
          refresh: tokens.refreshToken as string,
          id: tokens.idToken as string,
          expiresAt: tokens.expiresAt,
          scope,
          ...(tokens.earliestRefreshAt !== undefined ? { earliestRefreshAt: tokens.earliestRefreshAt } : {}),
        },
      };
      if (!sameUser) delete out.model;
      return out;
    });
    this.modelCache = undefined;
    // A valid identity is not permission to use the plan: that needs the granted scope.
    if (!hasPlanScope(scope)) throw new CompanionError('permission_required');
    return this.statusFrom(next);
  }

  private waitForCallback(result: Promise<URLSearchParams>, signal: AbortSignal): Promise<URLSearchParams> {
    const timeoutMs = this.options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;
    return new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new CompanionError('timeout', 'Sign-in timed out. Start again from GrammarMe.'))), timeoutMs);
      const onAbort = () => finish(() => reject(new CompanionError('cancelled', 'Sign-in cancelled.')));
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      result.then((p) => finish(() => resolve(p)));
    });
  }

  /**
   * Revokes the refresh token at OpenAI, then deletes tokens locally whatever happened. The host ID
   * and issued client ID are kept so the next sign-in is a re-authorization of the same install.
   */
  async signOut(): Promise<{ revoked: boolean }> {
    const cur = await this.store.read();
    let revoked = true;
    if (cur.tokens && cur.clientId) {
      revoked = false;
      try {
        const discovery = await this.oidc.discovery();
        if (discovery.revocationEndpoint) {
          revoked = await revokeRefreshToken(
            this.fetchFn,
            discovery.revocationEndpoint,
            { clientId: cur.clientId, refreshToken: cur.tokens.refresh },
            this.options.revokeBackoffMs,
          );
        }
      } catch {
        revoked = false;
      }
    }
    await this.store.update((latest) => {
      const out = withoutTokens(latest);
      delete out.profile;
      return out;
    });
    this.modelCache = undefined;
    return { revoked };
  }

  /* -------------------------------------------------------------- tokens */

  private async clearTokens(): Promise<void> {
    await this.store.update(withoutTokens);
  }

  /** A usable access token, refreshing first if it's close to expiry or was just rejected. */
  async accessToken(rejected?: string): Promise<string> {
    const cur = await this.store.read();
    if (!cur.tokens) throw new CompanionError('not_connected');
    if (!hasPlanScope(cur.tokens.scope)) throw new CompanionError('permission_required');
    if (rejected === undefined && !needsRefresh(cur.tokens, this.now())) return cur.tokens.access;
    // One refresh in flight per process; the file lock serializes across processes.
    this.refreshing ??= this.refresh(rejected).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private refresh(rejected: string | undefined): Promise<string> {
    return this.store.withLock(async () => {
      const cur = await this.store.read();
      if (!cur.tokens) throw new CompanionError('reauth_required');
      if (!cur.clientId) throw new CompanionError('reauth_required');
      const now = this.now();
      // Another process (or an earlier call) may have refreshed while we waited for the lock.
      const stillGood = rejected === undefined ? !needsRefresh(cur.tokens, now) : cur.tokens.access !== rejected && cur.tokens.expiresAt > now;
      if (stillGood) return cur.tokens.access;

      const discovery = await this.oidc.discovery();
      const result = await refreshGrant(
        this.fetchFn,
        discovery.tokenEndpoint,
        { clientId: cur.clientId, refreshToken: cur.tokens.refresh, now },
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
      if (!result.ok) {
        if (result.clearTokens) await this.store.write(withoutTokens(cur));
        throw result.error;
      }
      const t = result.tokens;
      const next: CredentialFile = {
        ...cur,
        tokens: {
          access: t.accessToken,
          // Refresh tokens rotate: always keep the newest one.
          refresh: t.refreshToken ?? cur.tokens.refresh,
          id: t.idToken ?? cur.tokens.id,
          expiresAt: t.expiresAt,
          scope: t.scope ?? scopeFromAccessToken(t.accessToken) ?? cur.tokens.scope,
          ...(t.earliestRefreshAt !== undefined ? { earliestRefreshAt: t.earliestRefreshAt } : {}),
        },
      };
      await this.store.write(next);
      return t.accessToken;
    });
  }

  /** Runs `fn` with an access token; on a bare 401, refreshes once and retries. */
  private async authorized<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      const token = await this.accessToken();
      try {
        return await fn(token);
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e;
        return await fn(await this.accessToken(token));
      }
    } catch (e) {
      // Disconnected in ChatGPT settings, revoked or expired: forget the tokens so status says so.
      if (e instanceof CompanionError && e.code === 'reauth_required') await this.clearTokens().catch(() => {});
      throw e instanceof UnauthorizedError ? new CompanionError('reauth_required') : e;
    }
  }

  /* -------------------------------------------------------------- models */

  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    const list = await this.authorized((token) => fetchModels(this.fetchFn, this.endpoints.apiOrigin, token, signal));
    this.modelCache = list;
    return list;
  }

  async setModel(slug: string, signal?: AbortSignal): Promise<StatusPayload> {
    let list = this.modelCache;
    if (!list?.some((m) => m.slug === slug)) list = await this.models(signal);
    if (!list.some((m) => m.slug === slug)) throw new CompanionError('model_unavailable');
    return this.statusFrom(await this.store.update((cur) => ({ ...cur, model: slug })));
  }

  /** The saved model, or the first listed one (which is then saved). */
  private async resolveModel(signal: AbortSignal): Promise<string> {
    const cur = await this.store.read();
    if (!cur.tokens) throw new CompanionError('not_connected');
    if (!hasPlanScope(cur.tokens.scope)) throw new CompanionError('permission_required');
    if (cur.model) return cur.model;
    const first = (await this.models(signal))[0];
    if (!first) throw new CompanionError('model_unavailable', 'No ChatGPT models are available to this account.');
    await this.store.update((latest) => (latest.model ? latest : { ...latest, model: first.slug }));
    return first.slug;
  }

  /* -------------------------------------------------------------- inference */

  /** Runs `fn` under the check deadline, mapping aborts to `cancelled` or `timeout`. */
  private async bounded<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.checkTimeoutMs ?? AI_CHECK_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const aborted = () => new CompanionError(signal.aborted ? 'cancelled' : 'timeout');
    try {
      const result = await fn(combined);
      if (combined.aborted) throw aborted();
      return result;
    } catch (e) {
      const abortLike = !(e instanceof CompanionError) || e.code === 'network' || e.code === 'timeout' || e.code === 'cancelled';
      if (combined.aborted && abortLike) throw aborted();
      throw e;
    }
  }

  async check(input: CheckInput, signal: AbortSignal): Promise<CheckPayload> {
    return this.bounded(signal, async (s) => {
      const model = await this.resolveModel(s);
      const output = await this.authorized((token) =>
        streamResponse({
          fetchFn: this.fetchFn,
          apiOrigin: this.endpoints.apiOrigin,
          accessToken: token,
          model,
          instructions: buildSystemPrompt(input.task, input.mode),
          input: buildUserPrompt(input.text),
          maxOutputChars: AI_MAX_OUTPUT_CHARS,
          signal: s,
        }),
      );
      const parsed = parseModelJson(output);
      const list = parsed === undefined ? null : extractEditList(parsed);
      if (!list) throw new CompanionError('provider_error', 'ChatGPT’s answer wasn’t in the expected format.');
      const { edits, dropped } = sanitizeEdits(list, input.text, input.task, AI_MAX_EDITS);
      const droppedCount = Object.values(dropped).reduce((sum, n) => sum + (n ?? 0), 0);
      return { edits, dropped: droppedCount, model };
    });
  }

  /** A tiny round trip to prove the connection and plan usage work. Returns latency in ms. */
  async test(signal: AbortSignal): Promise<number> {
    return this.bounded(signal, async (s) => {
      const model = await this.resolveModel(s);
      const started = Date.now();
      await this.authorized((token) =>
        streamResponse({
          fetchFn: this.fetchFn,
          apiOrigin: this.endpoints.apiOrigin,
          accessToken: token,
          model,
          instructions: 'Reply with OK.',
          input: 'OK?',
          maxOutputChars: 2_000,
          signal: s,
        }),
      );
      return Date.now() - started;
    });
  }
}
