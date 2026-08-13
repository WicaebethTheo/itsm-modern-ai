import { lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/components/RequireAuth";
import { ToastProvider } from "@/components/ui/toast";
import { DEMO } from "@/lib/api";
// Les DEUX écrans servis en direct, et c'est délibéré : ils sont le premier contact avec le
// produit. `Setup` est la toute première visite (création du compte), `Login` toutes les
// suivantes. Les charger paresseusement ferait payer un aller-retour réseau supplémentaire
// à l'écran qu'on voit le plus, pour économiser des octets qu'on télécharge de toute façon.
import { Login } from "@/pages/Login";
import { Setup } from "@/pages/Setup";

/**
 * Les vingt écrans authentifiés sont chargés À LA DEMANDE.
 *
 * Mesuré sur ce dépôt : un chunk unique de 531,70 ko (162,92 ko gzip) — soit toutes les
 * pages du produit, y compris celles qu'un exploitant n'ouvre jamais (Bac à sable,
 * Développement, Supporter), téléchargées et surtout ANALYSÉES avant le premier pixel.
 *
 * Ce que cela vaut, honnêtement : sur un LAN, les octets ne coûtent presque rien. Le vrai
 * gain est le temps de parse et d'exécution de ce qu'on n'ouvre pas. C'est pourquoi les deux
 * écrans d'entrée restent statiques : on n'échange pas une latence certaine sur l'écran le
 * plus vu contre une économie théorique sur les autres.
 *
 * `import()` avec un chemin littéral, jamais construit : c'est ce qui permet à Vite de
 * découper à la compilation. Un `import(\`@/pages/${nom}\`)` embarquerait tout.
 */
const Account = lazy(() => import("@/pages/Account").then((m) => ({ default: m.Account })));
const AiProvider = lazy(() =>
  import("@/pages/AiProvider").then((m) => ({ default: m.AiProvider })),
);
const Automations = lazy(() =>
  import("@/pages/Automations").then((m) => ({ default: m.Automations })),
);
const CostQuotas = lazy(() =>
  import("@/pages/CostQuotas").then((m) => ({ default: m.CostQuotas })),
);
const Dashboard = lazy(() => import("@/pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Debug = lazy(() => import("@/pages/Debug").then((m) => ({ default: m.Debug })));
const Guardrails = lazy(() =>
  import("@/pages/engine/Guardrails").then((m) => ({ default: m.Guardrails })),
);
const Ingestion = lazy(() =>
  import("@/pages/engine/Ingestion").then((m) => ({ default: m.Ingestion })),
);
const Modes = lazy(() => import("@/pages/engine/Modes").then((m) => ({ default: m.Modes })));
const PromptReply = lazy(() =>
  import("@/pages/engine/PromptReply").then((m) => ({ default: m.PromptReply })),
);
const GlpiConnection = lazy(() =>
  import("@/pages/GlpiConnection").then((m) => ({ default: m.GlpiConnection })),
);
const Groups = lazy(() => import("@/pages/Groups").then((m) => ({ default: m.Groups })));
const Journal = lazy(() => import("@/pages/Journal").then((m) => ({ default: m.Journal })));
const Privacy = lazy(() => import("@/pages/Privacy").then((m) => ({ default: m.Privacy })));
const Sandbox = lazy(() => import("@/pages/Sandbox").then((m) => ({ default: m.Sandbox })));
const Scope = lazy(() => import("@/pages/Scope").then((m) => ({ default: m.Scope })));
const Status = lazy(() => import("@/pages/Status").then((m) => ({ default: m.Status })));
const Store = lazy(() => import("@/pages/Store").then((m) => ({ default: m.Store })));
const Technicians = lazy(() =>
  import("@/pages/Technicians").then((m) => ({ default: m.Technicians })),
);

export default function App() {
  return (
    <BrowserRouter
      basename={
        // Build démo dédié (sous-domaine, servi à la racine) → aucun préfixe.
        // Sinon démo in-product servie sous /demo → préfixe /demo. App réelle → racine.
        import.meta.env.VITE_DEMO === "true" ? undefined : DEMO ? "/demo" : undefined
      }
    >
      <ToastProvider>
        <Routes>
          {/* Routes PUBLIQUES (hors garde d'authentification) : la première installation
              précède, par construction, tout compte capable de la franchir. */}
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          {/* Routes protégées (Layout rendu par RequireAuth) */}
          <Route element={<RequireAuth />}>
            <Route index element={<Dashboard />} />
            <Route path="status" element={<Status />} />
            <Route path="journal" element={<Journal />} />
            <Route path="glpi" element={<GlpiConnection />} />
            <Route path="ai-provider" element={<AiProvider />} />
            {/* Le moteur : quatre écrans, plus une page de dix-sept réglages. `/engine`
                survit en REDIRECTION — la doc publique, les signets et le bouton « Régler
                le plafond dans Moteur » de Coûts & quotas le citent tous. */}
            <Route path="engine" element={<Navigate to="/engine/guardrails" replace />} />
            <Route path="engine/guardrails" element={<Guardrails />} />
            <Route path="engine/modes" element={<Modes />} />
            <Route path="engine/ingestion" element={<Ingestion />} />
            <Route path="engine/prompt" element={<PromptReply />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="cost" element={<CostQuotas />} />
            <Route path="scope" element={<Scope />} />
            <Route path="technicians" element={<Technicians />} />
            <Route path="groups" element={<Groups />} />
            <Route path="sandbox" element={<Sandbox />} />
            <Route path="store" element={<Store />} />
            <Route path="automations" element={<Automations />} />
            <Route path="debug" element={<Debug />} />
            {/* Hors sidebar : accessible depuis le menu de compte de la topbar. */}
            <Route path="account" element={<Account />} />
            {/* Chemin inconnu : sans cette route, la garde est SANS enfant correspondant,
                donc ni `RequireAuth` ni `Layout` ne montent — l'utilisateur reste devant une
                page ENTIÈREMENT blanche, sans barre ni topbar, sans autre issue que de
                réécrire l'URL. Un signet périmé suffit, et le découpage du moteur vient de
                multiplier les URL susceptibles d'être mal recopiées. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
