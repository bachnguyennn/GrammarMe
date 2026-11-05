/**
 * Fixed OpenAI endpoints and protocol constants for Sign in with ChatGPT, plus the filesystem
 * location of the companion's private state.
 *
 * Test hooks: GRAMMARME_COMPANION_TEST_AUTH_ORIGIN and GRAMMARME_COMPANION_TEST_API_ORIGIN replace
 * https://auth.openai.com and https://api.openai.com for automated tests. They only accept a
 * loopback host (127.0.0.1 or localhost); anything else is refused so the hooks can't be used to
 * send credentials elsewhere.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CompanionError } from './errors.ts';

export const DEFAULT_AUTH_ORIGIN = 'https://auth.openai.com';
export const DEFAULT_API_ORIGIN = 'https://api.openai.com';
/** The `resource` (RFC 8707) every token is requested for. */
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE] as const;
/** client_id for the first registration; OpenAI issues a per-install client_id in the callback. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME = 'GrammarMe';
export const CALLBACK_PATH = '/auth/callback';
/** Tried first for the loopback listener; any free port is used if it is taken. */
export const PREFERRED_CALLBACK_PORT = 1455;
/** The published GrammarMe extension. More IDs can be allowed with `install --extension-id`. */
export const DEFAULT_EXTENSION_ID = 'cflaepodgccnfddlhomomhbmhgkgikhf';

export const TEST_AUTH_ENV = 'GRAMMARME_COMPANION_TEST_AUTH_ORIGIN';
export const TEST_API_ENV = 'GRAMMARME_COMPANION_TEST_API_ORIGIN';
export const HOME_ENV = 'GRAMMARME_COMPANION_HOME';
export const OPEN_BROWSER_ENV = 'GRAMMARME_COMPANION_OPEN_BROWSER';

export interface Endpoints {
  authOrigin: string;
  apiOrigin: string;
  /** True when a test hook replaced the auth origin (discovered endpoints must then be loopback too). */
  testAuth: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function testOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompanionError('internal', `${name} is not a valid URL.`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHost(url.hostname)) {
    throw new CompanionError('internal', `${name} must point at 127.0.0.1 or localhost (it exists for automated tests only).`);
  }
  return url.origin;
}

export function resolveEndpoints(env: NodeJS.ProcessEnv = process.env): Endpoints {
  const auth = env[TEST_AUTH_ENV];
  const api = env[TEST_API_ENV];
  return {
    authOrigin: auth ? testOrigin(TEST_AUTH_ENV, auth) : DEFAULT_AUTH_ORIGIN,
    apiOrigin: api ? testOrigin(TEST_API_ENV, api) : DEFAULT_API_ORIGIN,
    testAuth: Boolean(auth),
  };
}

/** Only OpenAI's own HTTPS hosts (or loopback under the test hook) may appear in discovery. */
export function assertTrustedAuthUrl(value: unknown, endpoints: Endpoints): string {
  if (typeof value !== 'string') throw new CompanionError('provider_error', 'OpenAI sign-in configuration is incomplete.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompanionError('provider_error', 'OpenAI sign-in configuration is invalid.');
  }
  const ok = endpoints.testAuth
    ? isLoopbackHost(url.hostname)
    : url.protocol === 'https:' && (url.hostname === 'openai.com' || url.hostname.endsWith('.openai.com'));
  if (!ok) throw new CompanionError('provider_error', 'OpenAI sign-in configuration points at an unexpected host.');
  return url.href;
}

/** `$GRAMMARME_COMPANION_HOME`, else `$XDG_CONFIG_HOME/grammarme`, else `~/.config/grammarme`. */
export function companionHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV];
  if (override) return resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, 'grammarme');
}
