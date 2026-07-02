import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { snapshot as langSnapshot } from "./lib/i18n";
import { initTheme } from "./lib/theme";

initTheme(); // applique le thème stocké avant le rendu (évite le flash)
// `<html lang>` : setLang ne le pose qu'au changement de langue ; on l'initialise ici
// au chargement pour que la langue courante (FR/EN) soit correcte dès le premier rendu.
document.documentElement.setAttribute("lang", langSnapshot());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
