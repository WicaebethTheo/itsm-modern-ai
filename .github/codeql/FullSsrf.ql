/**
 * @name Full server-side request forgery
 * @description Requête réseau dont l'URL complète dépend d'une valeur externe. Variante
 *              de la requête standard `py/full-ssrf` qui reconnaît en plus le validateur
 *              anti-SSRF du projet (`domain/url_safety.py::validate_base_url`).
 * @kind path-problem
 * @problem.severity error
 * @security-severity 9.1
 * @precision high
 * @id itsm/full-ssrf
 * @tags security
 *       external/cwe/cwe-918
 */

// ─────────────────────────────────────────────────────────────────────────────────────
// POURQUOI CETTE REQUÊTE EXISTE
//
// `py/full-ssrf` signalait `api/routes/version.py` (vérification de mise à jour). En
// suivant le chemin de propagation, la « valeur utilisateur » était le paramètre `cfg`
// du handler FastAPI : le modèle FastAPI de CodeQL traite TOUT paramètre de route comme
// contrôlé par le client, alors que `cfg` est une dépendance injectée
// (`Depends(get_config_service)`), pas une donnée de requête.
//
// L'URL en question ne peut d'ailleurs pas venir d'un client : `update_check_url` n'est
// écrivable par aucune route et n'est pas exposée par l'UI — sa seule source est la
// variable d'environnement `UPDATE_CHECK_URL`. Et elle est validée avant l'appel.
//
// On NE désactive PAS la détection SSRF pour autant : ce serait perdre la couverture sur
// les clients GLPI et LLM, là où elle a une vraie valeur. On rejoue donc la requête
// standard à l'identique (mêmes sources, mêmes puits, même sévérité) en déclarant
// `validate_base_url` comme barrière. Un appel sortant NON validé reste signalé —
// vérifié par un test négatif au moment de l'écriture de cette requête.
//
// ⚠️ Si vous modifiez cette requête, testez avec `codeql database analyze --rerun` :
// sans ce drapeau, CodeQL ressert le résultat en cache et une barrière cassée passe
// pour fonctionnelle.
// ─────────────────────────────────────────────────────────────────────────────────────

import python
import semmle.python.dataflow.new.DataFlow
import semmle.python.dataflow.new.TaintTracking
import semmle.python.Concepts
import semmle.python.security.dataflow.ServerSideRequestForgeryCustomizations
import ServerSideRequestForgery
import Flux::PathGraph

/**
 * Appel au validateur anti-SSRF du projet.
 *
 * On ancre sur le nom de l'appelé ET sur l'existence de la définition au chemin attendu :
 * le graphe d'API (`API::moduleImport`) ne résout pas les imports relatifs utilisés dans
 * ce dépôt (`from ...domain.url_safety import validate_base_url`).
 */
predicate estValidateurProjet(DataFlow::CallCfgNode appel) {
  exists(Function cible |
    cible.getName() = "validate_base_url" and
    cible.getLocation().getFile().getRelativePath() = "src/itsm_modern_ai/domain/url_safety.py" and
    appel.getFunction().asCfgNode().(NameNode).getId() = cible.getName()
  )
}

private module Config implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) { source instanceof Source }

  predicate isSink(DataFlow::Node sink) { sink instanceof Sink }

  predicate isBarrier(DataFlow::Node node) {
    node instanceof Sanitizer
    or
    node instanceof FullUrlControlSanitizer
    or
    // Barrière du projet. `validate_base_url` impose https, rejette loopback, IP privée,
    // lien-local, multicast, réservé et non spécifié — et lève `UrlSafetyError` sinon.
    // On barre l'ARGUMENT autant que la valeur de retour : le flux entre dans la fonction
    // par l'argument puis ressort par `return url`, donc ne barrer que l'un des deux
    // laisse un chemin ouvert.
    exists(DataFlow::CallCfgNode appel |
      estValidateurProjet(appel) and
      (node = appel or node = appel.getArg(0))
    )
  }

  predicate observeDiffInformedIncrementalMode() { none() }
}

module Flux = TaintTracking::Global<Config>;

/** Vrai si TOUTES les parties de l'URL de `requete` proviennent de la valeur externe. */
predicate requeteEntierementControlee(Http::Client::Request requete) {
  forall(DataFlow::Node partie | partie = requete.getAUrlPart() | Flux::flowTo(partie))
}

from Flux::PathNode source, Flux::PathNode sink, Http::Client::Request requete
where
  requete = sink.getNode().(Sink).getRequest() and
  Flux::flowPath(source, sink) and
  requeteEntierementControlee(requete)
select requete, source, sink, "The full URL of this request depends on a $@.", source.getNode(),
  "user-provided value"
