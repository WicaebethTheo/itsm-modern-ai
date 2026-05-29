"""Test d'architecture : frontière hexagonale du domaine (project-context invariant).

Le package `domain/` est le cœur métier pur : il ne doit dépendre d'AUCUNE couche
externe (adapters, api, persistence, services, scheduler). Toute violation casse
l'inversion de dépendances et fait fuiter de l'infrastructure dans le cœur.
"""

from __future__ import annotations

import ast
from pathlib import Path

DOMAIN_DIR = Path(__file__).resolve().parents[2] / "src" / "itsm_modern_ai" / "domain"
FORBIDDEN = ("adapters", "api", "persistence", "services", "scheduler")
PACKAGE = "itsm_modern_ai"


def _imported_modules(path: Path) -> set[str]:
    """Renvoie les modules importés (absolus + résolus en relatif) par un fichier."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:  # import relatif : `from ..services import x`
                # niveau 1 = domain, 2 = package, etc. On reconstruit le préfixe.
                # Tous les fichiers domain sont à profondeur 1 sous le package.
                base = PACKAGE if node.level >= 2 else f"{PACKAGE}.domain"
                module = f"{base}.{module}" if module else base
            found.add(module)
    return found


def test_domain_has_no_forbidden_imports():
    assert DOMAIN_DIR.is_dir(), f"domain introuvable : {DOMAIN_DIR}"
    violations: list[str] = []
    for py in sorted(DOMAIN_DIR.glob("*.py")):
        for module in _imported_modules(py):
            for layer in FORBIDDEN:
                if module == f"{PACKAGE}.{layer}" or module.startswith(f"{PACKAGE}.{layer}."):
                    violations.append(f"{py.name} importe interdit : {module}")
    assert not violations, "Frontière hexagonale violée :\n" + "\n".join(violations)
