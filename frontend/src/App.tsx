import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/components/RequireAuth";
import { ToastProvider } from "@/components/ui/toast";
import { DEMO } from "@/lib/api";
import { Account } from "@/pages/Account";
import { AiProvider } from "@/pages/AiProvider";
import { Automations } from "@/pages/Automations";
import { CostQuotas } from "@/pages/CostQuotas";
import { Dashboard } from "@/pages/Dashboard";
import { Debug } from "@/pages/Debug";
import { Guardrails } from "@/pages/engine/Guardrails";
import { Ingestion } from "@/pages/engine/Ingestion";
import { Modes } from "@/pages/engine/Modes";
import { PromptReply } from "@/pages/engine/PromptReply";
import { GlpiConnection } from "@/pages/GlpiConnection";
import { Groups } from "@/pages/Groups";
import { Journal } from "@/pages/Journal";
import { Login } from "@/pages/Login";
import { Privacy } from "@/pages/Privacy";
import { Sandbox } from "@/pages/Sandbox";
import { Scope } from "@/pages/Scope";
import { Setup } from "@/pages/Setup";
import { Status } from "@/pages/Status";
import { Store } from "@/pages/Store";
import { Technicians } from "@/pages/Technicians";

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
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
