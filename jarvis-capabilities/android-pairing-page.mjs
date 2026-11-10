const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>JARVIS — Pareamento Android</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #10141c; color: #f3f5f8; }
    main { max-width: 34rem; margin: 0 auto; padding: 1.25rem; }
    section { background: #1b2230; border: 1px solid #303b4d; border-radius: 1rem; padding: 1.25rem; }
    h1 { font-size: 1.35rem; margin-top: 0; }
    p { line-height: 1.5; color: #c3ccda; }
    label { display: block; margin: 1rem 0 .4rem; font-weight: 600; }
    input, button { box-sizing: border-box; width: 100%; border-radius: .65rem; padding: .85rem; font: inherit; }
    input { color: #fff; background: #10141c; border: 1px solid #526078; }
    button { margin-top: 1rem; border: 0; background: #a8c7fa; color: #10141c; font-weight: 700; }
    button:disabled { opacity: .6; }
    #result { margin-top: 1.2rem; padding: 1rem; border-radius: .65rem; background: #10141c; overflow-wrap: anywhere; }
    #code { font-size: .92rem; user-select: all; }
    #status { min-height: 1.5rem; }
    .note { font-size: .9rem; }
  </style>
</head>
<body>
<main>
  <section>
    <h1>Vincular dispositivo Android</h1>
    <p>Esta página cria um código de pareamento de uso único, válido por cerca de 5 minutos. Use-a apenas no seu próprio serviço JARVIS e mantenha o código privado.</p>
    <form id="pair-form">
      <label for="admin-token">Token administrativo do servidor</label>
      <input id="admin-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required>
      <button id="generate" type="submit">Gerar código de pareamento</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
    <div id="result" hidden>
      <strong>Código de pareamento</strong>
      <p id="code"></p>
      <p class="note" id="expiry"></p>
      <p class="note">Agora abra o app JARVIS no Android, entre em “Vincular este dispositivo” e informe o código antes que expire.</p>
    </div>
  </section>
</main>
<script>
(() => {
  const form = document.getElementById("pair-form");
  const tokenInput = document.getElementById("admin-token");
  const button = document.getElementById("generate");
  const status = document.getElementById("status");
  const result = document.getElementById("result");
  const code = document.getElementById("code");
  const expiry = document.getElementById("expiry");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) return;
    button.disabled = true;
    status.textContent = "Solicitando código ao servidor…";
    result.hidden = true;
    code.textContent = "";
    expiry.textContent = "";
    try {
      const response = await fetch("/api/android/enrollment/pairing-code", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error"
      });
      const data = await response.json().catch(() => ({}));
      tokenInput.value = "";
      if (!response.ok || typeof data.code !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : "Não foi possível gerar o código.");
      }
      code.textContent = data.code;
      expiry.textContent = "Expira em: " + new Date(data.expiresAt).toLocaleTimeString();
      result.hidden = false;
      status.textContent = "Código gerado. Digite-o no aplicativo agora.";
    } catch (error) {
      tokenInput.value = "";
      status.textContent = error && error.message ? error.message : "Falha de conexão. Tente novamente.";
    } finally {
      button.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

export function registerAndroidPairingPage(app) {
  if (!app || typeof app.get !== "function") throw new TypeError("app Express inválido.");
  app.get("/android-pairing", (_req, res) => {
    res.status(200);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return res.send(PAGE);
  });
}
