const APP_PACKAGES = new Map([
  ["whatsapp", "com.whatsapp"],
  ["youtube", "com.google.android.youtube"],
  ["chrome", "com.android.chrome"],
  ["gmail", "com.google.android.gm"],
  ["maps", "com.google.android.apps.maps"],
  ["google maps", "com.google.android.apps.maps"],
  ["telefone", "com.google.android.dialer"],
  ["camera", "com.android.camera2"],
  ["câmera", "com.android.camera2"],
  ["fotos", "com.google.android.apps.photos"],
  ["google fotos", "com.google.android.apps.photos"],
  ["configurações", "com.android.settings"],
  ["configuracoes", "com.android.settings"],
]);

const SETTINGS = new Map([
  ["wifi", "wifi"], ["wi-fi", "wifi"], ["internet", "wifi"],
  ["bluetooth", "bluetooth"],
  ["tela", "display"], ["brilho", "display"], ["display", "display"],
  ["som", "sound"], ["volume", "sound"],
  ["acessibilidade", "accessibility"],
  ["aplicativos padrão", "default_apps"], ["aplicativos padrao", "default_apps"], ["apps padrão", "default_apps"], ["apps padrao", "default_apps"],
]);

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function matchAppName(text) {
  const normalized = normalize(text);
  for (const [alias, packageName] of APP_PACKAGES) {
    if (normalized === alias || normalized.endsWith(` ${alias}`) || normalized.includes(` ${alias} `)) {
      return { alias, packageName };
    }
  }
  return null;
}

/**
 * Resolves a narrow set of everyday Portuguese requests to trusted Android
 * actions. Unknown intents are deliberately left to the research/implementation
 * pipeline; model output is never accepted as an arbitrary action payload.
 */
export function resolveAndroidActionIntent(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 8000) return null;
  const text = normalize(message);
  const startsAsAction = /^(por favor )?(abra|abrir|abre|inicie|iniciar|execute|executar|ligue|ligar|telefone para|chame|chamar|copie|copiar|acesse|acessar|entre em|ir para|va para|vá para)\b/.test(text);
  if (!startsAsAction) return null;

  const call = /^(?:por favor )?(?:ligue|ligar|telefone para|chame|chamar)\s+(?:para\s+)?(.+)$/.exec(text);
  if (call) {
    const phoneNumber = call[1].replace(/^(?:o numero|numero)\s+/, "").trim();
    if (/^\+?[0-9][0-9 ()-]{3,35}$/.test(phoneNumber)) {
      return { action: { type: "dial_number", phoneNumber: phoneNumber }, goal: "Realizar uma ligação telefônica pelo discador Android", requiresUserConfirmation: true };
    }
    return null;
  }

  const settingMatch = /^(?:por favor )?(?:abra|abrir|abre|acesse|acessar|entre em|ir para|va para)\s+(?:as?\s+)?(?:configuracoes?\s+(?:de\s+)?|ajustes\s+(?:de\s+)?)(.+)$/.exec(text);
  if (settingMatch) {
    const settingName = settingMatch[1].trim();
    const setting = SETTINGS.get(settingName);
    if (setting) return { action: { type: "open_settings", setting }, goal: `Abrir as configurações Android de ${settingName}`, requiresUserConfirmation: false };
  }

  const bareSetting = /^(?:por favor )?(?:abra|abrir|abre|acesse|acessar|entre em|ir para|va para)\s+(?:o|a|as|os)?\s*(wifi|wi-fi|bluetooth|tela|brilho|display|som|volume|acessibilidade)$/.exec(text);
  if (bareSetting) {
    const setting = SETTINGS.get(bareSetting[1]);
    if (setting) return { action: { type: "open_settings", setting }, goal: `Abrir as configurações Android de ${bareSetting[1]}`, requiresUserConfirmation: false };
  }

  const appRequest = /^(?:por favor )?(?:abra|abrir|abre|inicie|iniciar|execute|executar)\s+(?:o app|a app|o aplicativo|a aplicacao)?\s*(.+)$/.exec(text);
  if (appRequest) {
    const app = matchAppName(appRequest[1]);
    if (app) return { action: { type: "open_app", packageName: app.packageName }, goal: `Abrir o aplicativo ${app.alias} no Android`, requiresUserConfirmation: false };
  }

  const urlRequest = /^(?:por favor )?(?:abra|abrir|acesse|acessar|entre em)\s+(https?:\/\/\S+)$/.exec(text);
  if (urlRequest) {
    try {
      const url = new URL(urlRequest[1]);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        return { action: { type: "open_url", url: url.toString() }, goal: "Abrir um endereço web no Android", requiresUserConfirmation: false };
      }
    } catch {}
  }

  const copyRequest = /^(?:por favor )?(?:copie|copiar)\s+(?:este texto:?\s*)?(.+)$/.exec(text);
  if (copyRequest) {
    const original = message.trim().replace(/^(?:por favor\s+)?(?:copie|copiar)\s+(?:este texto:?\s*)?/i, "").trim();
    if (original && original.length <= 2000) {
      return { action: { type: "copy_text", text: original }, goal: "Copiar texto para a área de transferência do Android", requiresUserConfirmation: false };
    }
  }

  return null;
}

export function getAndroidAppAllowlist() {
  return Object.fromEntries(APP_PACKAGES);
}
