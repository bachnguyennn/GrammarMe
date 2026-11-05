/**
 * The popup's "ChatGPT suggestions" section. All work happens in the service worker (the popup
 * closes as soon as the OpenAI sign-in tab opens); this file only renders state and sends requests.
 * Everything is built with textContent: nothing from the companion is parsed as HTML.
 */
import { MANAGE_USAGE_URL } from '@grammarme/core/companion';
import {
  AI_CONSENT_KEY,
  AI_SIGNIN_KEY,
  type AiModelsResponse,
  type AiSimpleResponse,
  type AiStatusResponse,
  type PopupAiRequest,
  type SignInState,
} from './ai-protocol.ts';

export const AI_SETUP_URL = 'https://github.com/bachnguyennn/GrammarMe/blob/main/docs/chatgpt.md';

function send<T>(req: PopupAiRequest): Promise<T> {
  return chrome.runtime.sendMessage(req) as Promise<T>;
}
const ask = (type: Exclude<PopupAiRequest['type'], 'aiSetModel'>) => ({ target: 'background', type }) as PopupAiRequest;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}
function link(text: string, href: string): HTMLAnchorElement {
  const a = el('a', undefined, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}
function statusRow(text: string, dot: '' | 'off' | 'bad' = ''): HTMLElement {
  const row = el('div', 'status');
  row.append(el('span', `dot ${dot}`.trim()), el('span', undefined, text));
  return row;
}

export async function mountAi(): Promise<void> {
  const body = document.getElementById('ai-body')!;
  (document.getElementById('ai-guide') as HTMLAnchorElement).href = AI_SETUP_URL;
  const consent = document.getElementById('ai-consent')!;
  document.getElementById('ai-consent-ok')!.addEventListener('click', async () => {
    consent.hidden = true;
    await chrome.storage.local.set({ [AI_CONSENT_KEY]: true });
  });

  const show = (...nodes: Node[]) => {
    const stack = el('div', 'stack');
    stack.append(...nodes);
    body.replaceChildren(stack);
  };

  const continueButton = () => {
    const b = button('Continue with ChatGPT', 'btn chatgpt');
    b.addEventListener('click', async () => {
      b.disabled = true;
      // Must run inside this click: Chrome only shows the permission prompt for a user gesture.
      let granted = false;
      try {
        granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
      } catch {
        granted = false;
      }
      if (!granted) {
        b.disabled = false;
        return render({ error: 'GrammarMe can’t reach its companion without that permission. Nothing was connected.' });
      }
      const st = await send<AiStatusResponse>(ask('aiStatus'));
      if (!st.companion) return render();
      const r = await send<AiSimpleResponse>(ask('aiConnect'));
      if (!r.ok) return render({ error: r.message });
      render(); // shows "finish signing in"; the popup usually closes when the tab opens
    });
    return b;
  };

  const render = async (extra: { error?: string; note?: string } = {}): Promise<void> => {
    const st = await send<AiStatusResponse>(ask('aiStatus')).catch(() => null);
    const sign = ((await chrome.storage.session.get(AI_SIGNIN_KEY))[AI_SIGNIN_KEY] ?? null) as SignInState | null;
    const errorNode = extra.error ? [el('p', 'err', extra.error)] : [];
    const noteNode = extra.note ? [el('p', 'note', extra.note)] : [];

    if (!st) return show(el('p', 'err', 'GrammarMe’s background service didn’t answer. Close and reopen this window.'));
    if (!st.ok) return show(el('p', 'err', (st as unknown as { message?: string }).message ?? 'Something went wrong.'));

    if (st.signingIn || sign?.state === 'waiting') {
      const cancel = button('Cancel sign-in');
      cancel.addEventListener('click', async () => {
        await send(ask('aiCancelConnect'));
        setTimeout(() => void render(), 300);
      });
      return show(statusRow('Finish signing in to ChatGPT in the tab that opened.', 'off'), cancel);
    }

    if (!st.permission) {
      return show(
        el('p', 'note', 'Not connected. You’ll need the companion installed first.'),
        continueButton(),
        ...errorNode,
      );
    }

    if (!st.companion) {
      const retry = button('Check again');
      retry.addEventListener('click', () => void render());
      return show(
        statusRow('Companion not found', 'bad'),
        el('p', 'note', st.message ?? 'Install the GrammarMe companion, then check again.'),
        link('How to install the companion ↗', AI_SETUP_URL),
        retry,
      );
    }

    const lastError = sign?.state === 'error' ? [el('p', 'err', sign.message ?? 'Sign-in didn’t complete.')] : [];
    const status = st.status;

    if (!status?.connected) {
      return show(statusRow('Not connected', 'off'), ...noteNode, continueButton(), ...lastError, ...errorNode);
    }

    if (!status.account?.planUsage) {
      return show(
        statusRow(`Signed in${status.account?.email ? ` as ${status.account.email}` : ''}`, 'bad'),
        el('p', 'err', 'ChatGPT plan usage wasn’t allowed, so GrammarMe can’t send checks. Connect again and allow it.'),
        continueButton(),
        disconnectButton(),
      );
    }

    // Connected with plan usage.
    if (sign?.state === 'done') {
      await chrome.storage.session.remove(AI_SIGNIN_KEY);
      if (!(await chrome.storage.local.get(AI_CONSENT_KEY))[AI_CONSENT_KEY]) consent.hidden = false;
    }
    const who = statusRow(`Connected${status.account.email ? ` as ${status.account.email}` : ''}`);
    const plan = el('div', 'plan');
    plan.append(el('span', undefined, 'Using ChatGPT plan · '), link('Manage usage ↗', MANAGE_USAGE_URL));

    const modelLabel = el('label', 'note', 'Model');
    const select = el('select');
    select.disabled = true;
    select.append(new Option('Loading models…', ''));
    modelLabel.append(select);
    void send<AiModelsResponse>(ask('aiModels')).then((m) => {
      select.replaceChildren();
      if (!m.ok) {
        select.append(new Option('Couldn’t load models', ''));
        return;
      }
      for (const model of m.models) select.append(new Option(model.displayName || model.slug, model.slug));
      if (m.selected) select.value = m.selected;
      select.disabled = m.models.length === 0;
    });
    select.addEventListener('change', async () => {
      const r = await send<AiSimpleResponse>({ target: 'background', type: 'aiSetModel', model: select.value });
      if (!r.ok) void render({ error: r.message });
    });

    const test = button('Test connection');
    const result = el('p', 'note');
    test.addEventListener('click', async () => {
      test.disabled = true;
      result.className = 'note';
      result.textContent = 'Testing… (uses a tiny amount of your plan allowance)';
      const r = await send<AiSimpleResponse>(ask('aiTest'));
      test.disabled = false;
      if (r.ok) result.textContent = `Working. ChatGPT answered in ${((r.latencyMs ?? 0) / 1000).toFixed(1)} s.`;
      else {
        result.className = 'err';
        result.textContent = r.message;
      }
    });
    const acts = el('div', 'acts');
    acts.append(test, disconnectButton());
    return show(who, plan, modelLabel, acts, result, ...noteNode, ...errorNode);
  };

  function disconnectButton(): HTMLButtonElement {
    const b = button('Disconnect');
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await send<AiSimpleResponse>(ask('aiDisconnect'));
      if (!r.ok) return render({ error: r.message });
      return render({
        note:
          r.revoked === false
            ? 'Disconnected and deleted from this computer. OpenAI couldn’t be reached to revoke the session; you can also remove GrammarMe in ChatGPT settings.'
            : 'Disconnected. The companion deleted its ChatGPT credentials from this computer.',
      });
    });
    return b;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[AI_SIGNIN_KEY]) void render();
  });
  await render();
}
