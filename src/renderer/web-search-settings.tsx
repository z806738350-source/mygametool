import { useEffect, useState } from "react";
import type { WebSearchSettings } from "../shared/web-search.js";
import { clearWebSearchCredentials, getWebSearchSettings } from "./api.js";
import { t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

export function WebSearchSettingsPanel() {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [settings, setSettings] = useState<WebSearchSettings>();
  const [error, setError] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let disposed = false;
    setSettings(undefined);
    setError(undefined);
    void getWebSearchSettings().then(next => {
      if (!disposed) setSettings(next);
    }).catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { disposed = true; };
  }, [serviceGeneration]);

  async function clearKeys() {
    setClearing(true);
    setError(undefined);
    try {
      setSettings(await clearWebSearchCredentials());
      setCleared(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClearing(false);
    }
  }

  const hasKeys = settings?.exaApiKeyConfigured || settings?.parallelApiKeyConfigured || settings?.custom?.apiKeyConfigured;
  return (
    <section className="settings-panel settings-overview-panel settings-web-search-panel">
      <header className="settings-panel-header"><h3>{t("webSearch.title")}</h3></header>
      <p>{t("webSearch.disabled")}</p>
      {!settings && !error && <p className="settings-loading">{t("webSearch.loading")}</p>}
      {hasKeys && <div><button type="button" className="settings-secondary-button" disabled={clearing} onClick={() => void clearKeys()}>{t("webSearch.clearKeys")}</button></div>}
      {cleared && !hasKeys && <p role="status">{t("webSearch.cleared")}</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </section>
  );
}
