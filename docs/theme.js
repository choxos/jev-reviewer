// Light or dark: the system's choice until the toggle picks one, remembered on this device.
// Loaded in <head> so a saved theme applies before the first paint.
(() => {
  const root = document.documentElement;
  const saved = (() => {
    try {
      return localStorage.getItem("jr.theme");
    } catch {
      return null;
    }
  })();
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
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
