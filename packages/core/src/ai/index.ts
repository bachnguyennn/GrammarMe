/**
 * Provider-independent AI prompting and output validation, shared by every AI route (the
 * Cloudflare Worker and the local ChatGPT companion). Pure TypeScript: no network, no Node or
 * Worker APIs, so it is safe to bundle anywhere.
 */
export * from './prompts.ts';
export * from './sanitize.ts';
