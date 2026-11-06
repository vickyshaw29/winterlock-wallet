// Shared Winterlock navigation and appearance. The Flask companion and wallet workspace use identical assets.
// Written with Codex (OpenAI) for Vicky. Cross-app links carry appearance and an explicitly local workspace URL.
const root = document.documentElement;
const toggle = document.getElementById("theme-toggle");
const system = matchMedia("(prefers-color-scheme: dark)");
const query = new URLSearchParams(location.search);
const asked = query.get("theme");
if (asked === "dark" || asked === "light") root.dataset.theme = asked;
else {
  try {
    const saved = localStorage.getItem("winterlock.theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch { /* Appearance also works without storage. */ }
}
if (query.get("motion") === "reduce") root.classList.add("reduce-motion");

function workspaceOrigin() {
  try {
    const supplied = new URL(query.get("workspace") ?? "http://127.0.0.1:5173");
    if (supplied.protocol === "http:" && (supplied.hostname === "localhost" || supplied.hostname === "127.0.0.1")) return supplied.origin;
  } catch { /* Use the documented local workspace. */ }
  return "http://127.0.0.1:5173";
}
function draw() {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : system.matches;
  const theme = dark ? "dark" : "light";
  root.dataset.currentTheme = theme;
  if (toggle) {
    toggle.setAttribute("aria-label", dark ? "Use light theme" : "Use dark theme");
    toggle.setAttribute("aria-pressed", String(dark));
    const label = toggle.querySelector("span");
    if (label) label.textContent = dark ? "Light appearance" : "Dark appearance";
    else toggle.textContent = dark ? "Light appearance" : "Dark appearance";
  }
  for (const a of document.querySelectorAll("a[data-flask-link]")) {
    if (!(a instanceof HTMLAnchorElement)) continue;
    const href = new URL("http://localhost:15190");
    href.searchParams.set("workspace", location.origin);
    href.searchParams.set("theme", theme);
    a.href = href.toString();
  }
  for (const a of document.querySelectorAll("a[data-workspace-page]")) {
    if (!(a instanceof HTMLAnchorElement)) continue;
    const href = new URL(a.dataset.workspacePage || "/", workspaceOrigin());
    href.searchParams.set("theme", theme);
    a.href = href.toString();
  }
}
toggle?.addEventListener("click", () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : system.matches;
  root.dataset.theme = dark ? "light" : "dark";
  query.delete("theme");
  const search = query.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
  try { localStorage.setItem("winterlock.theme", root.dataset.theme); } catch { /* Optional. */ }
  draw();
});
system.addEventListener("change", draw);
draw();
