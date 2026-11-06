// A small element builder for the pages: text goes in as text, never as HTML, so nothing the backend, the sidecar or
// the chain returns can become markup.
// Written with Claude Code (AI) for Vicky.

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * el("button", { class: "btn", text: "Pay", onclick: f, disabled: true }, ...children)
 * Props: class, text, on<event> (a function); a boolean or number goes to the element's property of that name when it
 * has one (tabIndex, colSpan, disabled), else to the attribute (colspan: 6 sets colspan="6"); other values are
 * attributes. A name the element has no property for must never vanish into an expando property.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, unknown>} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
    else if ((typeof v === "boolean" || typeof v === "number") && k in e) /** @type {any} */ (e)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  append(e, children);
  return e;
}

/**
 * @param {Element} parent
 * @param {Child[]} children
 */
export function append(parent, children) {
  for (const c of children) if (c !== null && c !== undefined && c !== false) parent.append(typeof c === "number" ? String(c) : c);
}

/**
 * The element with this id; a missing one is a bug in the page, so it throws.
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} [type]
 * @returns {T}
 */
export function byId(id, type) {
  const e = document.getElementById(id);
  if (!e || (type && !(e instanceof type))) throw new Error(`the page has no #${id}${type ? ` of type ${type.name}` : ""}`);
  return /** @type {T} */ (e);
}

/**
 * A definition list item for facts: term (in Print) and value (in Ink). num (or its old name mono): tabular figures,
 * never a monospace font. lead: the line's main figure, set larger (the balance).
 * @param {string} term
 * @param {Child} value
 * @param {{ num?: boolean, mono?: boolean, lead?: boolean, title?: string }} [opts]
 */
export function item(term, value, opts = {}) {
  return el("div", { class: opts.lead ? "kv lead" : "kv" }, el("dt", { text: term }), el("dd", { class: opts.num || opts.mono ? "num" : undefined, title: opts.title }, value));
}
