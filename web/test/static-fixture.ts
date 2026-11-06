// An isolated static-server fixture. Application behavior is covered against dist/ by Playwright.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATIC_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Winterlock</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

export function createStaticFixture(): {
  publicDir: string;
  cleanup: () => void;
} {
  const publicDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "winterlock-web-static-"),
  );
  const assets = path.join(publicDir, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(publicDir, "index.html"), STATIC_HTML);
  fs.writeFileSync(path.join(assets, "app.js"), "export {};\n");
  fs.writeFileSync(path.join(assets, "app.css"), "body { margin: 0; }\n");
  // Actual production font bytes make the MIME/content checks useful without invoking Vite.
  for (const [family, font] of [
    ["ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
    ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"],
  ] as const) {
    fs.copyFileSync(
      path.join(import.meta.dir, "../node_modules/@fontsource", family, "files", font),
      path.join(assets, font),
    );
  }
  return {
    publicDir,
    cleanup: () => fs.rmSync(publicDir, { recursive: true, force: true }),
  };
}
