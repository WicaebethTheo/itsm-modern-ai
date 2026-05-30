"""Test d'architecture : frontière hexagonale du domaine (project-context invariant).

Le package `domain/` est le cœur métier pur : il ne doit dépendre d'AUCUNE couche
externe (adapters, api, persistence, services, scheduler). Toute violation casse
l'inversion de dépendances et fait fuiter de l'infrastructure dans le cœur.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[2] / "src" / "itsm_modern_ai"
DOMAIN_DIR = SRC_DIR / "domain"
PORTS_DIR = SRC_DIR / "ports"
FORBIDDEN = ("adapters", "api", "persistence", "services", "scheduler")
PACKAGE = "itsm_modern_ai"


def _imported_modules(path: Path, subpkg: str) -> set[str]:
    """Renvoie les modules importés (absolus + résolus en relatif) par un fichier.

    `subpkg` est le sous-package du fichier (ex. "domain", "ports"). Tous les fichiers
    audités sont à profondeur 1 sous le package, donc un import relatif de niveau 1
    (`from .x import y`) résout vers `PACKAGE.<subpkg>` et niveau >= 2 vers `PACKAGE`.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:  # import relatif : `from ..services import x`
                base = PACKAGE if node.level >= 2 else f"{PACKAGE}.{subpkg}"
                module = f"{base}.{module}" if module else base
            found.add(module)
    return found


def test_domain_has_no_forbidden_imports():
    assert DOMAIN_DIR.is_dir(), f"domain introuvable : {DOMAIN_DIR}"
    violations: list[str] = []
    for py in sorted(DOMAIN_DIR.glob("*.py")):
        for module in _imported_modules(py, "domain"):
            for layer in FORBIDDEN:
                if module == f"{PACKAGE}.{layer}" or module.startswith(f"{PACKAGE}.{layer}."):
                    violations.append(f"{py.name} importe interdit : {module}")
    assert not violations, "Frontière hexagonale violée :\n" + "\n".join(violations)


def test_ports_depend_only_on_domain():
    """Les `ports/` (Protocols d'inversion de dépendances) ne doivent dépendre QUE du
    `domain` (+ stdlib/typing/pydantic). Aucun import des couches concrètes
    (adapters, api, persistence, services, scheduler) ne doit fuiter dans les contrats :
    sinon le port n'est plus une abstraction mais un couplage déguisé.
    """
    assert PORTS_DIR.is_dir(), f"ports introuvable : {PORTS_DIR}"
    violations: list[str] = []
    for py in sorted(PORTS_DIR.glob("*.py")):
        for module in _imported_modules(py, "ports"):
            # Seuls les imports internes au package sont contraints ; stdlib/typing/
            # pydantic (externes) sont libres. On interdit les couches concrètes ET on
            # n'autorise, à l'intérieur du package, que `itsm_modern_ai.domain[.*]`.
            if not module.startswith(f"{PACKAGE}."):
                continue
            if module == f"{PACKAGE}.domain" or module.startswith(f"{PACKAGE}.domain."):
                continue
            violations.append(f"{py.name} importe hors-domain : {module}")
    assert not violations, (
        "Un port dépend d'autre chose que `domain` :\n" + "\n".join(violations)
    )
