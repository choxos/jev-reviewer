// Google Analytics (gtag.js) on the hosted copies: page views only. The page title and address it
// reports are fixed, so neither a study's name nor a file's address reaches Google, and files,
// questions and projects never do. It is a file of its own because the site's security policy
// allows no inline script. Not loaded on this computer (localhost, a file) or in automated
// browsers such as the tour recorder.
(() => {
  const ID = "G-MK439ZVTV4";
  if (navigator.webdriver || location.protocol === "file:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments); // gtag.js reads arguments objects, not arrays
  };
  gtag("js", new Date());
  gtag("set", { page_title: /\/guide\/?$/.test(location.pathname) ? "Jev Reviewer guide" : "Jev Reviewer", page_location: location.origin + location.pathname });
  gtag("config", ID);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${ID}`;
  document.head.append(script);
})();
