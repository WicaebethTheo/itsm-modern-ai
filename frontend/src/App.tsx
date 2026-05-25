import { BrowserRouter, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/components/RequireAuth";
import { AiProvider } from "@/pages/AiProvider";
import { Dashboard } from "@/pages/Dashboard";
import { EngineSettings } from "@/pages/EngineSettings";
import { GlpiConnection } from "@/pages/GlpiConnection";
import { Journal } from "@/pages/Journal";
import { Login } from "@/pages/Login";
import { Sandbox } from "@/pages/Sandbox";
import { Status } from "@/pages/Status";
import { Technicians } from "@/pages/Technicians";

export default function App() {
  return (
    <BrowserRouter>
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
          <Route path="technicians" element={<Technicians />} />
          <Route path="sandbox" element={<Sandbox />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
