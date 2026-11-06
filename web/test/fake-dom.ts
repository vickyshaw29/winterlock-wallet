// A tiny DOM for the screens' tests, no dependency: elements with attributes, children and text; the properties the
// pages use, reflected the way browsers reflect them and only on the elements that have them (so dom.js's choice of
// property or attribute is tested for real: a td has colSpan, nothing has "colspan"); events that bubble, with
// preventDefault; click() as browsers do it for disabled controls (a disabled fieldset included), submit buttons,
// checkboxes and radios; compound selectors (tag, #id, .class, [attr], [attr="v"], comma lists); and a document
// parsed from a page's HTML, nested as in the file. Event listeners' promises are kept, so a test can await them.
// Written with Claude Code (AI) for Vicky.

type Listener = (ev: FakeEvent) => unknown;
type Child = FakeElement | FakeText;

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly key: string | undefined;
  readonly clientX: number;
  target: FakeElement | null = null;
  currentTarget: FakeElement | FakeDocument | null = null;
  defaultPrevented = false;
  stopped = false;
  constructor(type: string, init: { bubbles?: boolean; key?: string; clientX?: number } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.key = init.key;
    this.clientX = init.clientX ?? 0;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

export class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent() { return this.data; }
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeElement {
  readonly localName: string;
  readonly namespaceURI: string;
  readonly attrs = new Map<string, string>();
  childNodes: Child[] = [];
  parentNode: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  constructor(readonly ownerDocument: FakeDocument, tag: string, ns = "http://www.w3.org/1999/xhtml") {
    this.localName = tag.toLowerCase();
    this.namespaceURI = ns;
  }

  get tagName() { return this.localName.toUpperCase(); }
  setAttribute(name: string, value: string) { this.attrs.set(name.toLowerCase(), String(value)); }
  getAttribute(name: string) { return this.attrs.get(name.toLowerCase()) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name.toLowerCase()); }
  removeAttribute(name: string) { this.attrs.delete(name.toLowerCase()); }
  /** a boolean attribute: present or not */
  protected flag(name: string, on: boolean) { if (on) this.setAttribute(name, ""); else this.removeAttribute(name); }

  get id() { return this.getAttribute("id") ?? ""; }
  set id(v: string) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", v); }
  get title() { return this.getAttribute("title") ?? ""; }
  set title(v: string) { this.setAttribute("title", v); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v: boolean) { this.flag("hidden", v); }
  get tabIndex() { const v = this.getAttribute("tabindex"); return v === null ? (this.focusable() ? 0 : -1) : Number(v); }
  set tabIndex(v: number) { this.setAttribute("tabindex", String(v)); }
  protected focusable() { return false; }
  get dataset(): Record<string, string | undefined> {
    return new Proxy({}, {
      get: (_t, k) => (typeof k === "string" ? this.getAttribute(`data-${kebab(k)}`) ?? undefined : undefined),
      set: (_t, k, v) => { this.setAttribute(`data-${kebab(String(k))}`, String(v)); return true; },
      deleteProperty: (_t, k) => { this.removeAttribute(`data-${kebab(String(k))}`); return true; },
      has: (_t, k) => this.hasAttribute(`data-${kebab(String(k))}`),
    });
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const write = (c: string[]) => { this.className = [...new Set(c)].join(" "); };
    return {
      contains: (c: string) => list().includes(c),
      add: (...c: string[]) => write([...list(), ...c]),
      remove: (...c: string[]) => write(list().filter((x) => !c.includes(x))),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !list().includes(c);
        write(on ? [...list(), c] : list().filter((x) => x !== c));
        return on;
      },
    };
  }

  get children(): FakeElement[] { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null; }
  get parentElement(): FakeElement | null { return this.parentNode; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.replaceChildren(...(v === "" ? [] : [v])); }
  /** the text as a person reads it: whitespace runs as one space */
  get text() { return this.textContent.replace(/\s+/g, " ").trim(); }

  private adopt(nodes: (Child | string)[]): Child[] {
    return nodes.map((n) => {
      const c = typeof n === "string" ? new FakeText(n) : n;
      if (c.parentNode) c.parentNode.childNodes = c.parentNode.childNodes.filter((x) => x !== c);
      c.parentNode = this;
      return c;
    });
  }
  append(...nodes: (Child | string)[]) { this.childNodes.push(...this.adopt(nodes)); }
  prepend(...nodes: (Child | string)[]) { this.childNodes.unshift(...this.adopt(nodes)); }
  replaceChildren(...nodes: (Child | string)[]) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this); this.parentNode = null; } }

  *descendants(): Generator<FakeElement> {
    for (const c of this.children) { yield c; yield* c.descendants(); }
  }
  matches(sel: string) { return parseSelectors(sel).some((c) => matches(this, c)); }
  querySelectorAll(sel: string): FakeElement[] {
    const cs = parseSelectors(sel);
    return [...this.descendants()].filter((e) => cs.some((c) => matches(e, c)));
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string) {
    for (let e: FakeElement | null = this; e; e = e.parentNode) if (e.matches(sel)) return e;
    return null;
  }

  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  dispatchEvent(ev: FakeEvent): boolean {
    ev.target = this;
    const path: (FakeElement | FakeDocument)[] = [];
    for (let e: FakeElement | null = this; e; e = e.parentNode) path.push(e);
    if (this.isConnected()) path.push(this.ownerDocument);
    for (const node of ev.bubbles ? path : path.slice(0, 1)) {
      ev.currentTarget = node;
      for (const fn of node.listeners.get(ev.type) ?? []) this.ownerDocument.keep(fn.call(node, ev));
      if (ev.stopped) break;
    }
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
  isConnected() { let e: FakeElement = this; while (e.parentNode) e = e.parentNode; return e === this.ownerDocument.documentElement; }

  /** A disabled form control, or one inside a disabled fieldset, gets no click (as in browsers). */
  get disabledForClicks(): boolean {
    for (let e: FakeElement | null = this.parentNode; e; e = e.parentNode) if (e instanceof FakeFieldSet && e.disabled) return true;
    return false;
  }
  click() { this.dispatchEvent(new FakeEvent("click")); }
  focus() { this.ownerDocument.focused = this; this.dispatchEvent(new FakeEvent("focus", { bubbles: false })); }
  blur() { if (this.ownerDocument.focused === this) this.ownerDocument.focused = null; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 64, right: 300, bottom: 64, x: 0, y: 0 }; }
  get clientWidth() { return 300; }
}

export class FakeTableCell extends FakeElement {
  get colSpan() { return Number(this.getAttribute("colspan") ?? 1); }
  set colSpan(v: number) { this.setAttribute("colspan", String(v)); }
}
export class FakeOList extends FakeElement {
  get start() { return Number(this.getAttribute("start") ?? 1); }
  set start(v: number) { this.setAttribute("start", String(v)); }
}
export class FakeAnchor extends FakeElement {
  get href() { return this.getAttribute("href") ?? ""; }
  set href(v: string) { this.setAttribute("href", v); }
  protected override focusable() { return true; }
}
export class FakeForm extends FakeElement {}
export class FakeFieldSet extends FakeElement {
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v: boolean) { this.flag("disabled", v); }
}
export class FakeButton extends FakeElement {
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v: boolean) { this.flag("disabled", v); }
  get type() { return this.getAttribute("type") ?? "submit"; }
  set type(v: string) { this.setAttribute("type", v); }
  protected override focusable() { return true; }
  override click() {
    if (this.disabled || this.disabledForClicks) return;
    const ev = new FakeEvent("click");
    this.dispatchEvent(ev);
    const form = this.closest("form");
    if (!ev.defaultPrevented && this.type === "submit" && form) form.dispatchEvent(new FakeEvent("submit"));
  }
}
export class FakeInput extends FakeElement {
  private _value: string | null = null;
  private _checked: boolean | null = null;
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v: boolean) { this.flag("disabled", v); }
  get type() { return this.getAttribute("type") ?? "text"; }
  set type(v: string) { this.setAttribute("type", v); }
  get name() { return this.getAttribute("name") ?? ""; }
  get value() { return this._value ?? this.getAttribute("value") ?? (this.type === "radio" || this.type === "checkbox" ? "on" : ""); }
  set value(v: string) { this._value = String(v); }
  get checked() { return this._checked ?? this.hasAttribute("checked"); }
  set checked(v: boolean) { this._checked = !!v; }
  get max() { return this.getAttribute("max") ?? ""; }
  set max(v: string) { this.setAttribute("max", v); }
  get min() { return this.getAttribute("min") ?? ""; }
  set min(v: string) { this.setAttribute("min", v); }
  get readOnly() { return this.hasAttribute("readonly"); }
  protected override focusable() { return true; }
  /** what a person typing does: the value, then an input event */
  enter(text: string) { this.value = text; this.dispatchEvent(new FakeEvent("input")); }
  override click() {
    if (this.disabled || this.disabledForClicks) return;
    const was = this.checked;
    if (this.type === "checkbox") this.checked = !was;
    if (this.type === "radio") {
      for (const r of this.ownerDocument.querySelectorAll(`input[name="${this.name}"]`)) if (r instanceof FakeInput && r !== this) r.checked = false;
      this.checked = true;
    }
    this.dispatchEvent(new FakeEvent("click"));
    if ((this.type === "checkbox" || this.type === "radio") && this.checked !== was) {
      this.dispatchEvent(new FakeEvent("input"));
      this.dispatchEvent(new FakeEvent("change"));
    }
  }
}

const CLASSES: Record<string, new (d: FakeDocument, tag: string) => FakeElement> = {
  td: FakeTableCell, th: FakeTableCell, ol: FakeOList, a: FakeAnchor, form: FakeForm, fieldset: FakeFieldSet, button: FakeButton, input: FakeInput,
};

export class FakeDocument {
  readonly documentElement: FakeElement;
  focused: FakeElement | null = null;
  hidden = false;
  listeners = new Map<string, Listener[]>();
  private pending: Promise<unknown>[] = [];
  constructor() {
    this.documentElement = this.createElement("html");
    this.documentElement.append(this.createElement("head"), this.createElement("body"));
  }
  get head() { return this.documentElement.querySelector("head")!; }
  get body() { return this.documentElement.querySelector("body")!; }
  get activeElement() { return this.focused ?? this.body; }
  createElement(tag: string): FakeElement {
    const C = CLASSES[tag.toLowerCase()] ?? FakeElement;
    return new C(this, tag);
  }
  createElementNS(ns: string, tag: string) { return new FakeElement(this, tag, ns); }
  getElementById(id: string) { return [...this.documentElement.descendants()].find((e) => e.id === id) ?? null; }
  querySelectorAll(sel: string) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel: string) { return this.documentElement.querySelector(sel); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener() {}
  /** a listener's answer: kept when it is a promise, so settle() can wait for it */
  keep(r: unknown) { if (r && typeof (r as Promise<unknown>).then === "function") this.pending.push(r as Promise<unknown>); }
  /** Waits until every listener's promise has settled, and the timers they started at 0 ms have run. */
  async settle() {
    for (let i = 0; i < 50; i++) {
      const p = this.pending.splice(0);
      await Promise.allSettled(p);
      await new Promise((r) => setTimeout(r, 1));
      if (this.pending.length === 0 && p.length === 0) return;
    }
    throw new Error("fake-dom: the listeners never settled");
  }
}

// ------------------------------------------------------------------ selectors

type Compound = { tag: string | null; id: string | null; classes: string[]; attrs: { name: string; value: string | null }[] };

const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

function parseSelectors(sel: string): Compound[] {
  return sel.split(",").map((raw) => {
    const s = raw.trim();
    const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\]\s]+))\s*)?\]/y;
    let at = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (m[1] !== undefined) { if (at !== 0) throw new Error(`fake-dom: unsupported selector "${sel}"`); c.tag = m[1].toLowerCase(); }
      else if (m[2] !== undefined) c.id = m[2];
      else if (m[3] !== undefined) c.classes.push(m[3]);
      else c.attrs.push({ name: m[4]!.toLowerCase(), value: m[5] !== undefined ? unescape(m[5]) : m[6] ?? m[7] ?? null });
      at = re.lastIndex;
    }
    if (at !== s.length || s === "") throw new Error(`fake-dom: unsupported selector "${sel}"`);
    return c;
  });
}

function matches(e: FakeElement, c: Compound): boolean {
  if (c.tag && e.localName !== c.tag) return false;
  if (c.id && e.id !== c.id) return false;
  const cls = e.className.split(/\s+/);
  if (!c.classes.every((x) => cls.includes(x))) return false;
  return c.attrs.every((a) => (a.value === null ? e.hasAttribute(a.name) : e.getAttribute(a.name) === a.value));
}

// ------------------------------------------------------------------ pages

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: "\u00a0" };
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m);

/** A document from a page's HTML: every element nested as in the file, its attributes and its text. */
export function parsePage(html: string): FakeDocument {
  const doc = new FakeDocument();
  const root = doc.documentElement;
  root.replaceChildren();
  const stack: FakeElement[] = [];
  const top = () => stack.at(-1);
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(token)) {
    if (m[1]) {
      const i = stack.map((e) => e.localName).lastIndexOf(m[1].toLowerCase());
      if (i >= 0) stack.length = i;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const e = tag === "html" ? root : doc.createElement(tag);
      for (const a of (m[3] ?? "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) e.setAttribute(a[1]!, decode(a[2] ?? a[3] ?? a[4] ?? ""));
      if (e !== root) (top() ?? root).append(e);
      if (!VOID.has(tag) && !m[4]) stack.push(e);
    } else if (m[5] && m[5].trim() && top()) {
      top()!.append(decode(m[5]));
    }
  }
  return doc;
}

/**
 * Makes a document the global one, with the classes the pages test with instanceof, CSS.escape and location; the
 * answer puts the globals back.
 */
export function installDom(doc: FakeDocument, search = ""): () => void {
  const g = globalThis as Record<string, unknown>;
  const set: Record<string, unknown> = {
    document: doc, HTMLElement: FakeElement, HTMLAnchorElement: FakeAnchor, HTMLButtonElement: FakeButton, HTMLInputElement: FakeInput,
    HTMLFieldSetElement: FakeFieldSet, HTMLFormElement: FakeForm, HTMLTableCellElement: FakeTableCell, HTMLOListElement: FakeOList,
    CSS: { escape: (s: string) => s.replace(/["\\]/g, "\\$&") }, location: { search },
  };
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  for (const [k, v] of Object.entries(set)) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  return () => {
    for (const [k, d] of Object.entries(before)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  };
}
