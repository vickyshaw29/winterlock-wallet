// The pages without a browser: every id a script asks for exists in its page, every screen has the shared parts
// (banner, wallet header, Mempool switch, lane board, status line), and the rules the CSP and the brief rely on hold:
// no inline script or style, no innerHTML, no script from elsewhere, the attribution line on every file.
// Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const PUBLIC = path.resolve(import.meta.dir, "../public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf8");
const ids = (html: string) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
/** byId("x"), input("x") and button("x") calls in a script */
const asked = (js: string) => [...js.matchAll(/\b(?:byId|input|button)\("([^"]+)"/g)].map((m) => m[1]!);
const SHARED = ["banner", "banner-text", "banner-retry", "wallet-head", "notice", "status", "set-aside", "lane-limits", "device-issue", "lanes"];
const SCREENS = ["hot-cold", "agent", "session"];

describe("wiring", () => {
  for (const page of SCREENS) {
    test(`${page}.html has every id ${page}.js and ui.js ask for, the Mempool switch and its module`, () => {
      const html = read(`${page}.html`), have = ids(html);
      const missing = [...new Set([...asked(read(`${page}.js`)), ...SHARED])].filter((id) => !have.has(id));
      expect(missing).toEqual([]);
      expect(html).toContain(`<script type="module" src="${page}.js"></script>`);
      expect(html.match(/name="mempool" value="(alt|public)"/g)).toEqual(['name="mempool" value="alt"', 'name="mempool" value="public"']);
      expect(html).toMatch(/<fieldset data-sends/); // what the stalled banner turns off
      expect(html).toContain(`aria-current="page"`);
      expect(html).toContain(`<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="${page}.css">`);
      expect(fs.existsSync(path.join(PUBLIC, `${page}.css`))).toBe(true);
    });
  }

  test("index.html has every id index.js asks for", () => {
    const have = ids(read("index.html"));
    expect(asked(read("index.js")).filter((id) => !have.has(id))).toEqual([]);
  });

  test("no id is used twice in a page", () => {
    for (const page of [...SCREENS, "index"]) {
      const all = [...read(`${page}.html`).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      expect([page, all.length]).toEqual([page, new Set(all).size]);
    }
  });
});

describe("rules", () => {
  const files = fs.readdirSync(PUBLIC).filter((f) => /\.(html|js|css)$/.test(f));

  test("every file starts with its purpose and the attribution line", () => {
    for (const f of files) {
      const head = read(f).split("\n").slice(0, 4).join("\n");
      expect([f, head.includes("Written with Claude Code (AI) for Vicky.")]).toEqual([f, true]);
    }
  });

  test("no inline script or style, no script from elsewhere, no innerHTML, no gradients", () => {
    for (const f of files) {
      const s = read(f);
      if (f.endsWith(".html")) {
        expect([f, [...s.matchAll(/<script(?![^>]*\bsrc=")[^>]*>/g)].length]).toEqual([f, 0]);
        expect([f, /<script[^>]*src="(?:https?:)?\/\//.test(s)]).toEqual([f, false]);
        expect([f, /\sstyle="/.test(s), /\son[a-z]+="/.test(s)]).toEqual([f, false, false]);
      }
      if (f.endsWith(".js")) expect([f, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s)]).toEqual([f, false]);
      if (f.endsWith(".css")) expect([f, /gradient\(/.test(s)]).toEqual([f, false]);
    }
  });

  test("no remote resource at all: no page, script or stylesheet names Google Fonts or another host; the fonts are self-hosted", () => {
    for (const f of files) {
      const s = read(f);
      expect([f, /googleapis|gstatic/.test(s)]).toEqual([f, false]);
      if (f.endsWith(".html")) {
        expect([f, [...s.matchAll(/(?:src|href)="(?:https?:)?\/\/[^"]+"/g)].map((m) => m[0])]).toEqual([f, []]);
        expect([f, s.includes('<link rel="stylesheet" href="style.css">')]).toEqual([f, true]);
      }
      if (f.endsWith(".css")) expect([f, [...s.matchAll(/url\(\s*["']?(?:https?:)?\/\//g)].length]).toEqual([f, 0]);
    }
    // the two faces of the design note, latin subsets, swapped in when loaded, each file present with its OFL text
    const css = read("style.css");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(faces.map((f) => /font-family: "([^"]+)"/.exec(f)?.[1])).toEqual(["Archivo", "Besley"]);
    const LATIN = "unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;";
    for (const face of faces) {
      expect(face).toContain("font-display: swap;");
      expect(face).toContain(LATIN);
      const url = /src: url\("(fonts\/[a-z-]+\.woff2)"\) format\("woff2"\)/.exec(face)?.[1];
      expect([url, url !== undefined && fs.existsSync(path.join(PUBLIC, url))]).toEqual([url, true]);
    }
    expect(faces[0]).toContain("font-stretch: 62% 125%;"); // Archivo's width axis: condensed heads, the wide machine line
    for (const ofl of ["OFL-Archivo.txt", "OFL-Besley.txt"]) expect(fs.existsSync(path.join(PUBLIC, "fonts", ofl))).toBe(true);
    expect(css).toMatch(/--sans: "Archivo", /);
    expect(css).toMatch(/--serif: "Besley", /);
    // no monospace anywhere, in any stylesheet; light and dark, by the OS setting or the ?theme= aid
    const uncommented = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const f of files.filter((x) => x.endsWith(".css"))) expect([f, /monospace|JetBrains|\bInter\b/.test(uncommented(f))]).toEqual([f, false]);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  });

  test("table cells stay table cells on desktop: no flex or grid box on a cell the lane board draws", () => {
    // outside @media blocks, a rule whose last compound names a cell (td, th, or a class board.js puts on a td) sets no display
    const cellClasses = [...read("board.js").matchAll(/el\("td", \{[^}]*?\bclass: (?:"([^"]+)"|`([^`]+)`)/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/));
    expect(cellClasses).toEqual(expect.arrayContaining(["action", "status-cell", "num", "lane", "empty"]));
    let css = files.filter((f) => f.endsWith(".css")).map(read).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    for (let m; (m = /@media[^{]*\{/.exec(css));) { // cut each @media block, nested braces counted
      let depth = 1, i = m.index + m[0].length;
      for (; depth > 0 && i < css.length; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
      css = css.slice(0, m.index) + css.slice(i);
    }
    const bad = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel, body]) => /\bdisplay\s*:/.test(body!) && sel!.split(",").some((one) => {
      const last = one.trim().split(/[\s>+~]+/).at(-1) ?? "";
      return /^(td|th)\b/.test(last) || cellClasses.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(last));
    })).map(([, sel]) => sel!.trim());
    expect(bad).toEqual([]);
  });

  test("words: leaves, never leafs; every screen has its Play scene button inside a fieldset sending turns off", () => {
    for (const f of files) {
      const s = read(f);
      expect([f, /\bleafs\b/i.test(s), /leaf\$\{[^}]*"s"/.test(s)]).toEqual([f, false, false]);
    }
    for (const page of SCREENS) expect(read(`${page}.html`)).toMatch(/<fieldset data-sends class="scene" id="scene-fields">\s*<button class="btn" type="button" id="play">Play scene<\/button>/);
  });

  test("no fee bump anywhere: the screens never offer one", () => {
    // "never fee-bumped" and "never a fee bump" say it is not offered; any other mention would be an offer
    for (const f of files) expect([f, /fee[- ]bump/i.test(read(f).replace(/never (?:a )?fee[- ]bump(?:ed)?/gi, ""))]).toEqual([f, false]);
  });

  test("the stuck payment is a 4-second first deadline, never a low fee: no file sends maxFeePerGasWei or speaks of 1 wei per gas", () => {
    for (const f of files) {
      const s = read(f);
      expect([f, /1 wei per gas|below the base fee, so it/i.test(s)]).toEqual([f, false]);
      // api.js documents the field the backend accepts; nothing else names it
      if (f !== "api.js") expect([f, s.includes("maxFeePerGasWei")]).toEqual([f, false]);
    }
    const hint = read("hot-cold.html");
    expect(hint).toContain("The stuck payment's first try gets only 4 seconds, less than one 6-second block of the devnet, so it should miss its block and expire");
    expect(hint).toContain("A few tries in a hundred still land in time"); // never promised: it should miss, it does not always
    expect(hint).toContain("A low fee would not make it stuck: on this devnet a fee below the 7-wei base fee is refused at admission, and any fee above it is included.");
  });

  test("lane limits: every draft number is labelled the ERC-8421 draft's; every public one-per-sender is labelled not yet confirmed", () => {
    for (const f of files) {
      const s = read(f).replace(/\s+/g, " ");
      for (const m of s.matchAll(/64 per unstaked sender|4 per key/g)) {
        expect([f, m[0], s.slice(Math.max(0, m.index - 60), m.index).includes("ERC-8421 draft")]).toEqual([f, m[0], true]);
      }
      for (const m of s.matchAll(/one pending (?:frame transaction )?per sender/g)) {
        expect([f, m[0], s.slice(m.index, m.index + 160).includes("not yet confirmed on the devnet")]).toEqual([f, m[0], true]);
      }
    }
  });

  test("parallel lanes: the name where lanes run at once, on every screen's scene hint", () => {
    for (const page of SCREENS) expect([page, /parallel lanes/.test(read(`${page}.html`).match(/<fieldset data-sends class="scene"[\s\S]*?<\/fieldset>/)?.[0] ?? "")]).toEqual([page, true]);
  });
});
