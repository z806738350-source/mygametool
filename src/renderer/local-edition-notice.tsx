import { t } from "./i18n.js";

export function LocalEditionNotice({ message }: { message?: string } = {}) {
  return <section className="settings-panel settings-overview-panel">
    <header className="settings-panel-header"><h3>{t("localEdition.title")}</h3></header>
    <p>{message ?? t("localEdition.cloudUnavailable")}</p>
  </section>;
}
