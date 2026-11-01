// Upotus: <script src="https://PALVELIN/widget.js" data-business="yrityksen-tunnus" defer></script>
(() => {
  const s = document.currentScript, b = s?.dataset.business;
  if (!b) return console.warn("Vastimo: data-business puuttuu");
  const origin = new URL(s.src).origin;
  const btn = document.createElement("button");
  btn.textContent = "Kysy meiltä";
  btn.setAttribute("aria-label", "Avaa asiakaspalvelija");
  btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#1e5bd8;color:#fff;border:0;border-radius:99px;padding:14px 20px;font:600 15px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(11,42,111,.35)";
  const frame = document.createElement("iframe");
  frame.title = "Asiakaspalvelija";
  frame.style.cssText = "display:none;position:fixed;right:16px;bottom:72px;z-index:2147483647;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));border:0;border-radius:14px;box-shadow:0 8px 30px rgba(11,42,111,.35);background:#eef3fc";
  btn.onclick = () => {
    if (!frame.src) frame.src = `${origin}/?b=${encodeURIComponent(b)}&embed=1`;
    const open = frame.style.display === "none";
    frame.style.display = open ? "block" : "none";
    btn.textContent = open ? "Sulje" : "Kysy meiltä";
  };
  document.body.append(frame, btn);
})();
