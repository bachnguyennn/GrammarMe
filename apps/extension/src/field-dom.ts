/** DOM adapters for the pure field rules in eligibility.ts. */
import { OPT_OUT_SELECTOR, type FieldInfo } from './eligibility.ts';

export type TextField = HTMLTextAreaElement | HTMLInputElement;

export function asTextField(target: EventTarget | null | undefined): TextField | null {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target : null;
}

/** `Element.closest` that also climbs out of (open) shadow roots. */
export function closestComposed(el: Element, selector: string): Element | null {
  let node: Element | null = el;
  while (node) {
    const hit = node.closest(selector);
    if (hit) return hit;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** The focused element, looking inside open shadow roots (web components). */
export function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

export function describeField(el: TextField): FieldInfo {
  const rect = el.getBoundingClientRect();
  return {
    tagName: el.tagName,
    type: el.getAttribute('type'),
    autocomplete: el.getAttribute('autocomplete'),
    name: el.getAttribute('name'),
    id: el.id || null,
    readOnly: el.readOnly,
    disabled: el.disabled || el.matches(':disabled'),
    ariaHidden: closestComposed(el, '[aria-hidden="true"]') !== null,
    optedOut: closestComposed(el, OPT_OUT_SELECTOR) !== null,
    spellcheck: el.getAttribute('spellcheck'),
    width: rect.width,
    height: rect.height,
  };
}
