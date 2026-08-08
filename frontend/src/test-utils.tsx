/**
 * Helpers de test partagés — évite de redéclarer le ToastProvider dans chaque test
 * de page qui déclenche une action de sauvegarde (le toast est rendu côté App).
 */

import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ToastProvider } from "@/components/ui/toast";

export function renderWithToast(ui: ReactElement, options?: RenderOptions) {
  return render(<ToastProvider>{ui}</ToastProvider>, options);
}
