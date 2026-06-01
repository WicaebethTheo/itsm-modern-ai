/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build démo dédié (sous-domaine statique) : force le mode démo quel que soit le chemin. */
  readonly VITE_DEMO?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
