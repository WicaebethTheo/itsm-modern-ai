import { RequireAuth } from "@/components/RequireAuth";
import { ToastProvider } from "@/components/ui/toast";
import { DEMO } from "@/lib/api";
import { AiProvider } from "@/pages/AiProvider";
import { Automations } from "@/pages/Automations";
import { CostQuotas } from "@/pages/CostQuotas";
import { Dashboard } from "@/pages/Dashboard";
import { Debug } from "@/pages/Debug";
import { EngineSettings } from "@/pages/EngineSettings";
import { GlpiConnection } from "@/pages/GlpiConnection";
import { Groups } from "@/pages/Groups";
import { Journal } from "@/pages/Journal";
import { Login } from "@/pages/Login";
import { Privacy } from "@/pages/Privacy";
import { Sandbox } from "@/pages/Sandbox";
import { Scope } from "@/pages/Scope";
import { Status } from "@/pages/Status";
import { Store } from "@/pages/Store";
import { Technicians } from "@/pages/Technicians";
import { BrowserRouter, Route, Routes } from "react-router-dom";

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
          <Route path="/login" element={<Login />} />
          {/* Routes protégées (Layout rendu par RequireAuth) */}
          <Route element={<RequireAuth />}>
            <Route index element={<Dashboard />} />
            <Route path="status" element={<Status />} />
            <Route path="journal" element={<Journal />} />
            <Route path="glpi" element={<GlpiConnection />} />
            <Route path="ai-provider" element={<AiProvider />} />
            <Route path="engine" element={<EngineSettings />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="cost" element={<CostQuotas />} />
            <Route path="scope" element={<Scope />} />
            <Route path="technicians" element={<Technicians />} />
            <Route path="groups" element={<Groups />} />
            <Route path="sandbox" element={<Sandbox />} />
            <Route path="store" element={<Store />} />
            <Route path="automations" element={<Automations />} />
            <Route path="debug" element={<Debug />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
