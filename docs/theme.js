// Light or dark: the system's choice until the toggle picks one, remembered on this device.
// Also whether the projects column is open. Loaded in <head> so both apply before the first paint.
(() => {
  const root = document.documentElement;
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const saved = read("jr.theme");
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  // Wide screens show the column unless it was folded (or the window is small); phones open it on demand.
  const wide = matchMedia("(min-width: 60rem)").matches;
  root.dataset.side = wide && (read("jr.side") || (innerWidth >= 1200 ? "open" : "closed")) === "open" ? "open" : "closed";
  const dark = () => root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const label = (btn) => {
    btn.setAttribute("aria-pressed", String(dark()));
    btn.setAttribute("aria-label", dark() ? "Switch to the light theme" : "Switch to the dark theme");
    btn.title = btn.getAttribute("aria-label");
  };
  addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("themeBtn");
    if (!btn) return;
    label(btn);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => label(btn));
    btn.addEventListener("click", () => {
      root.dataset.theme = dark() ? "light" : "dark";
      try {
        localStorage.setItem("jr.theme", root.dataset.theme);
      } catch {}
      label(btn);
    });
  });
})();
