## 2026-08-09 — 0.9.56 — Sauvegarde accessible en déploiement *pull-only* + fenêtre de doublon refermée

Deux trous d'exploitation identifiés en revue de préparation à la production.

### 1. On ne pouvait pas sauvegarder sans les sources

La logique de sauvegarde ne vivait que dans le `Makefile`. Or la voie **recommandée** est
*pull-only* (image GHCR, Portainer, `docker run`, one-liner) : un exploitant qui suivait la
documentation n'avait **aucun moyen de sauvegarder** — sur un volume contenant à la fois les
données RGPD et la `master.key` sans laquelle la base est **définitivement illisible**.

```bash
docker compose exec itsm python -m itsm_modern_ai.backup
```

Copie **à chaud** (aucun arrêt de service) par `VACUUM INTO`, puis **vérifiée** :
`PRAGMA integrity_check` **et** comptage réel des tables et des lignes — `integrity_check`
valide la structure, pas le fait que le fichier contienne quoi que ce soit. La `master.key`
est jointe à la sauvegarde, ou son absence explicitement signalée. Échec **bruyant** : code de
sortie ≠ 0 et aucun dossier laissé à moitié fait, une sauvegarde à laquelle on ferait
confiance à tort étant pire que pas de sauvegarde. PostgreSQL est **refusé** avec la marche à
suivre (`pg_dump`) plutôt que faussement réussi.

Le `Makefile` **délègue** désormais au module : deux implémentations divergeraient, et c'est
celle de l'exploitant — la moins testée — qui casserait.

### 2. Le doublon de réponse publique en `full_auto`

Le poller appelait le handler **puis** posait le marqueur « traité ». Un arrêt brutal entre
les deux (OOM, reboot, `kill`) laissait l'écriture GLPI faite sans trace locale : le cycle
suivant rejouait le Ticket — donc, en `full_auto`, une **seconde réponse publique au
demandeur**. Le défaut était documenté dans le code depuis l'audit, jamais refermé.

**Marquage en deux temps**, sans aucun appel GLPI supplémentaire :

1. le poller **réserve** le Ticket avant d'appeler le handler ;
2. `mark_processed` **libère** la réservation en fin de cycle ;
3. un triage rejouable (panne LLM, plafond) **rend** la réservation — sans quoi une coupure
   de trois secondes brûlerait le Ticket définitivement, régression bien pire que le défaut.

Une réservation orpheline signifie « traitement interrompu après une écriture GLPI possible ».
Le Ticket n'est **pas** rejoué : une seconde réponse au demandeur est pire qu'un Ticket laissé
au triage humain. L'interruption est signalée en `ERROR` au cycle suivant, avec les
identifiants concernés — jamais avalée.

Le rejeu borné existant sur exception **attrapée** est préservé : le processus est alors
vivant, et c'est l'arrêt brutal — où aucun code ne s'exécute — que ce mécanisme couvre. La
fenêtre passe de « tout le traitement » à « une écriture SQLite locale ».

Tests : **555** pytest (+12). Migration `e8d3a71c46b9` éprouvée sur base peuplée et en
aller-retour.

## 2026-08-09 — 0.9.55 — Le repli n'échoue plus sur un acteur déjà assigné

**Défaut trouvé en validant la 0.9.54 contre un GLPI 11 réel — invisible pour les mocks.**

`POST TeamMember` sur un acteur **déjà assigné** répond `400 ERROR_INVALID_PARAMETER`. Le cas
est courant en production : une règle GLPI pré-affecte un groupe par défaut **sans** poser de
catégorie ; le ticket n'est donc pas « déjà traité » (`rules_fully_handled` exige les deux), il
part au moteur, se fait refuser — et le repli tente d'assigner un groupe qui y figure déjà.

Conséquence avant correctif : un `WARNING` par ticket concerné, un `fallback_applied=False` au
Journal, et un Suivi qui **omettait la ligne « Repli »** — alors que l'état visé était atteint,
le groupe étant bien assigné. Rien de corrompu, mais un moteur qui sous-déclare ce qu'il a fait.

### Le correctif

On ne se fie **pas** au code d'erreur — `ERROR_INVALID_PARAMETER` est générique et couvrirait
d'autres fautes. On relit l'**état** : si l'acteur visé est présent dans l'équipe du ticket,
l'objectif est atteint et on rend la main ; sinon l'erreur d'origine repart intacte. Le chemin
nominal ne paie **aucun appel supplémentaire**, et une relecture impossible (réseau, droits)
fait remonter l'erreur d'origine plutôt que de la déguiser en succès.

Le connecteur legacy n'est pas concerné : il passe par un `PUT Ticket`, idempotent par nature.

### Ce que la validation lab a confirmé par ailleurs

Contre un GLPI 11 réel (API V2, OAuth), sur des tickets de test isolés du poller :

- **« Router, jamais classer »** — après repli, catégorie et priorité **inchangées**, groupe
  assigné avec le rôle `assigned` ;
- **le Suivi « non tranché » est bien PRIVÉ** (`is_private: true`), accents et emoji rendus ;
- **pipeline complet** (refus → Suivi + repli → Journal) : `accepted=False`, `applied=False`,
  `fallback_applied=True` ;
- **congés** : l'absent sort du périmètre effectif, le remplaçant hérite de ses domaines et
  gagne la ligne « Assure l'intérim de … jusqu'au … » dans le prompt de routage.

Tests : **543** pytest (+4, dont les quatre branches du rattrapage : acteur déjà présent,
acteur absent, chemin nominal sans relecture, relecture en échec).

## 2026-08-09 — 0.9.54 — « À trier » cesse d'être un trou noir : suivi, repli assigné, congés

> Cette version regroupe le travail des incréments **0.9.50 à 0.9.54**, qui n'ont jamais été
> publiés séparément (aucune image, aucune release) : un seul numéro atteint les instances.

### Le point de départ, mesuré en conditions réelles

Un ticket refusé par le garde-fou ne recevait **rien** dans GLPI — ni champ, ni suivi — et
n'était **jamais réexaminé** (son motif n'appartient pas à `RETRYABLE_REASONS`, le poller le
marquait « traité »). Il restait « Nouveau », **indistinguable d'un ticket que personne n'a
ouvert**. La seule trace vivait dans le Journal de la console, c'est-à-dire nulle part du
point de vue du technicien qui travaille dans GLPI.

**Mesuré sur une instance de lab : 7 tickets sur 20, soit 35 % du flux invisible**, sur une
instance présentée comme « full-auto ».

### Un ticket « à trier » est désormais visible

Un refus **arbitré** (le LLM a répondu, le code a dit non) dépose un **Suivi privé « non
tranché »** : motif du refus en français, catégorie / priorité / affectation envisagées,
confiance annoncée. Le technicien reçoit un ticket honnêtement étiqueté, avec de quoi
trancher en dix secondes.

Ce que ce suivi **n'est pas** :

- **aucune mutation** — il informe, il n'applique pas. Il vaut donc dans les **trois** modes,
  `suggestion` compris ;
- **aucun brouillon de réponse**, délibérément. Une confiance sous le seuil est basse sur
  l'**ensemble** de la Décision : afficher un brouillon qu'un technicien pressé
  copierait-collerait réintroduirait par l'affichage la Décision que le garde-fou vient de
  refuser ;
- **aucune valeur présentée comme validée** — tout ce qui est hors périmètre est étiqueté
  comme tel, ce qui indique du même coup à l'admin ce qu'il faudrait rendre éligible.

Une **panne** (LLM injoignable, plafond atteint) n'écrit rien : le ticket est simplement
rejoué au cycle suivant. Confondre les deux familles aurait produit une annotation par cycle
sur une coupure réseau de trois secondes, puis un doublon au rejeu.

### …et il a désormais un propriétaire

Une **cible de repli par entité** (page Périmètre, à côté du mode). Quand le garde-fou refuse,
le ticket est **assigné** à cette cible — et rien d'autre.

- **Router, jamais classer.** Aucune catégorie, aucune priorité n'est posée : une mauvaise
  catégorie est pire qu'aucune, elle serait crue par les stats, les règles GLPI et le
  technicien.
- **Groupe d'abord**, technicien possible : un groupe encaisse une absence sans
  configuration, là où une personne nommée comme filet de toute l'instance est un point de
  défaillance unique.
- **Jamais en mode `suggestion`** — assigner *est* une mutation, et ce mode promet zéro
  mutation.
- **Cible revalidée contre la whitelist au moment de l'écriture**, et refusée à
  l'enregistrement si elle n'est pas éligible : une configuration silencieusement inopérante
  est pire qu'un refus clair.

### Congés & remplaçants

Un technicien absent **sort du périmètre effectif** : jamais proposé au modèle, donc jamais
assigné. Plutôt que de corriger la Décision après coup — ce qui créerait une divergence entre
le Journal et ce que GLPI reçoit.

**Le remplaçant hérite des compétences, pas seulement du nom.** Dire au modèle « route vers B »
sans lui dire *pourquoi* B convient, c'est lui demander d'assigner du réseau à quelqu'un
décrit comme faisant de la bureautique : confiance basse, puis rejet par le seuil. B absorbe
donc les **domaines** de l'absent et gagne une ligne « assure l'intérim de X jusqu'au … ».

Bornes **incluses**, granularité **jour**, évaluées dans le **fuseau local configuré**
(`LOCAL_TIMEZONE`, défaut `Europe/Paris`). L'absence **expire d'elle-même** : rien à
réactiver le lundi matin. Un remplaçant non éligible, ou lui-même absent sur la période, est
refusé à la saisie — l'intérim ne se chaîne pas.

### Carte de couverture des domaines

Bandeau de diagnostic **prédictif** sur les pages Techniciens et Groupes : domaines que
**personne** ne couvre (« à trier » garanti dès qu'un ticket en relève) et domaines tenus par
**une seule personne** sans groupe de repli. Il réagit aux cases cochées **avant**
enregistrement. Cardinalités uniquement, aucun acteur nommé.

### Invariants amendés — explicitement, pas contournés

- « Aucune **écriture** GLPI sans whitelist + seuil » → « aucune **mutation de champ** ».
  Déposer un suivi n'écrit aucun champ : il informe, il n'applique pas.
- « Mutation via la **seule porte** `apply_decision` » → « via le **seul port** `ItsmPort` »,
  avec deux méthodes aux contrats disjoints : `apply_decision` (Décision acceptée) et
  `assign_actor` (repli, assignation seule). Élargir la première en aurait fait un couteau
  suisse dont l'appelant décide des invariants.

L'échappatoire reste **unique** : la Décision demeure `accepted=False` au Journal. C'est ce
qu'on **fait** des tickets qui l'empruntent qui change, pas le nombre de branches du moteur.

### RGPD

La table des absences porte une donnée personnelle (« qui est absent, quand »). Elle est
conservée tant que l'absence est **en cours ou à venir** — c'est de la configuration active
qui pilote le routage — puis **purgée** avec le Journal une fois **terminée** : le produit n'a
aucune raison de constituer l'historique des vacances de chacun. Ce n'est pas une métrique par
technicien : on enregistre une **disponibilité déclarée par l'admin**, jamais une mesure
d'activité ou de présence effective. `docs/dpo.md` documente la table et le fait qu'un
remplaçant nommé apparaît dans le prompt envoyé au fournisseur LLM.

### Livraison : `main` ne part plus en production tout seul

`latest` — ce que tire tout `docker compose pull` — ne bouge désormais **que sur une release
publiée**. Un merge dans `main` produit `edge` + `sha-<court>` : publier redevient un acte
explicite, et qui veut suivre la pointe tire `:edge` en connaissance de cause.

| Tag | Contenu |
|---|---|
| `latest` | dernière version **publiée** — défaut recommandé |
| `X.Y.Z` / `X.Y` | version figée |
| `edge` | préversion, état intégré de `main` entre deux releases |

### Vérifications

- **539 tests pytest** (+42) et **141 Vitest** (+15) ; ruff, Biome, tsc, build Vite.
- Deux migrations (`a4c81d2e6f30`, `c7b2f4a19d55`) éprouvées **à vide, sur base peuplée et en
  aller-retour** — un nouveau job de CI rejoue ces trois chemins à chaque PR, une révision
  cassée n'étant pas détectable par les tests unitaires.
- Portes de couverture ajoutées : **88,0 % de branches** au backend, **72,1 %** au frontend.
- Protection de branche sur `main` : PR obligatoire, cinq checks requis, squash seul.

## 2026-08-08 — 0.9.49 — Compétences cochables : un routage exploitable dès l'installation

### Le problème, observé en conditions réelles

Sur une instance fraîchement installée, **7 propositions sur 20 étaient rejetées en
`low_confidence`**. La cause n'était ni la whitelist ni le modèle : `routing_prose`
n'incluait que les techniciens dont la **fiche en prose était remplie**. Tant que l'admin
n'avait rien rédigé, le LLM recevait une liste de noms **sans aucune description** et
routait sur un patronyme. Il s'en tirait mal — et le seuil de confiance faisait son travail
en rejetant. Le produit demandait donc un travail de rédaction avant de rendre le moindre
service.

### Ce que ça change

- **14 domaines de compétence cochables** (`domain/skills.py`) couvrant un service IT type :
  poste de travail, impression, réseau & Wifi, VPN, messagerie, téléphonie, comptes &
  droits, applications métier, ERP & comptabilité, sécurité, mobilité, serveurs &
  sauvegarde, accès physique, licences. Cocher suffit à rendre un technicien **exploitable
  par le moteur**, sans rédiger une ligne.
- **Chaque domaine embarque un indice** transmis au LLM avec le libellé (« Réseau & Wifi
  (connectivité, Wifi, switches, DHCP/DNS, câblage) »). Sans lui, « Réseau » et « VPN » se
  confondent et le modèle hésite entre deux techniciens — soit exactement la confiance
  basse qu'on cherche à supprimer.
- **La prose reste, et prime.** Le prompt place le socle coché d'abord, la prose ensuite :
  une nuance rédigée (« ne gère pas les Mac », « astreinte le week-end ») l'emporte sur le
  domaine générique, car c'est la dernière information lue qui pèse le plus.
- **Console** : puces cliquables sous chaque technicien ou groupe éligible, libellées
  FR/EN, avec l'indice en infobulle. Le champ libre est recentré sur son vrai rôle —
  « Précisions libres : exceptions, spécialités, disponibilités ».

### Détails qui comptent

- **Le catalogue est servi par l'API** (`GET /api/skills`), jamais dupliqué côté client :
  deux listes divergentes feraient cocher des clés que le moteur ignorerait en silence.
- **Un client qui n'envoie pas le champ ne l'efface pas.** `skill_tags` absent = sélection
  préservée ; liste vide explicite = l'admin a décoché. La distinction est testée, parce
  que Pydantic sérialise un champ absent à `null` et rendait les deux cas indiscernables.
- **Les clés inconnues sont ignorées, pas rejetées** : perdre une case vaut mieux
  qu'empêcher un admin d'enregistrer son périmètre. Les clés sont stables — elles vivent
  en base ; seuls les libellés peuvent évoluer.
- **Migration `b3e5c1f27a04`** avec `server_default=""` : la colonne est `NOT NULL` et la
  table contient déjà le périmètre sélectionné. Sans défaut serveur, l'`ALTER TABLE`
  échouerait sur base peuplée — le défaut relevé sur `cb8ffef4f8f3`, vérifié non reproduit
  ici (migration testée à vide **et** sur base peuplée, aller-retour compris).
- **Panne du catalogue non bloquante** : si l'API échoue, les puces disparaissent mais la
  saisie libre reste utilisable. On n'ampute pas la page pour une liste d'aide.

### Tests

**492 → 497 pytest**, **111 → 115 Vitest**, verts sur 3.13 et 3.14.

# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/) ; le projet ne suit
pas SemVer strictement (version d'app dans `pyproject.toml`).

Les entrées les plus récentes sont en haut.

## 2026-08-08 — 0.9.48 — Garde-fous qui tiennent vraiment (audit de bout en bout)

Trois audits indépendants (moteur, sécurité/RGPD, exploitation) et une campagne de
mutation. **Bonne nouvelle d'abord** : sur 20 régressions injectées dans les invariants
critiques, 19 ont été attrapées par la suite de tests — la whitelist, le seuil de
confiance, le masquage, le mode d'exécution et le fail-closed de l'auth sont réellement
protégés. Les défauts corrigés ici ne sont pas dans la logique de triage : ils sont dans
**ce que le produit affirme** et dans **ce qu'il devient quand quelque chose se passe mal**.

### 🔴 Perte de données — la sauvegarde ne sauvegardait rien

- **`make backup` produisait une archive inutilisable.** La cible copiait `data/itsm.db`
  à chaud **sans le `-wal`**, où résident les écritures récentes (5 à 16 Mo en régime).
  Reproduit : la copie ne contenait **même pas la table**. Et le `2>/dev/null || true`
  affichait « Sauvegarde → backups/… » quoi qu'il arrive. Le problème ne se découvrait
  qu'au moment de restaurer. Remplacée par un `VACUUM INTO` (repli sur l'API `.backup`),
  cohérent en ligne, avec `PRAGMA integrity_check`, taille et nombre de lignes affichés,
  échec **bruyant** et suppression du dossier incomplet. Vérifié : 5 000 lignes sur
  5 000 restaurées, `integrity ok`.
- **Tickets brûlés définitivement en cas de panne.** Le poller marquait `processed` quel
  que soit le résultat : une clé LLM expirée deux heures, un plafond atteint à 14 h, et
  tous les tickets de la fenêtre étaient perdus **sans reprise possible**. Le code
  appliquait pourtant déjà le bon raisonnement au périmètre vide. Désormais
  `COST_CAP_REACHED` / `LLM_ERROR` / `INVALID_OUTPUT` ne consomment plus le ticket, avec
  un compteur d'essais borné (5) comme seconde ceinture — un plafond atteint ne coûte
  aucun essai, puisqu'il ne facture rien.
- **`master.key` perdue : verrouillage silencieux.** Une nouvelle clé était générée sans
  broncher, le login répondait « Mot de passe incorrect », et `/api/status` restait **au
  vert** pour la supervision. Le démarrage échoue désormais explicitement si des secrets
  chiffrés existent déjà, sans écrire de fichier — la restauration reste possible.
  Échappatoire assumée : `ITSM_ALLOW_NEW_MASTER_KEY=true`.

### 🔴 Le plafond de coût n'en était pas un

- **Les appels LLM en échec n'étaient jamais comptés** — alors qu'ils sont facturés
  (tokens générés puis rejetés au parsing). Mesuré : 50 tickets, **150 appels réels,
  0 ligne en base**, plafond jamais déclenché. Chaque tentative émise est désormais
  journalisée, échecs compris.
- **`usage` absent ⇒ coût 0.** Une passerelle qui n'émet pas ce bloc faisait avancer le
  compteur de 0,00 € indéfiniment — le même fail-open que faire confiance à `confidence`.
  L'absence devient une anomalie : estimation + avertissement.
- **Base en échec ⇒ boucle facturée sans garde-fou.** Disque plein : l'insertion échouait
  aussi, donc le plafond restait aveugle pendant que les appels se répétaient (~85 €/jour
  sans rien produire). Circuit-breaker après 3 échecs d'écriture, et une base illisible
  vaut désormais « plafond atteint » (défaut sûr).

### 🔴 Les artefacts de preuve mentaient

- **Le journal de la sandbox attestait un masquage non appliqué.** Il journalisait avec
  *tous* les motifs actifs alors que l'envoi réel utilise les flags gatés Supporter : en
  Community, la preuve destinée à la DPO affichait `[IBAN]`, `[SECRET]`, `[IP]` pour des
  données parties **en clair**. Le test de non-régression verrouille la propriété forte :
  le prompt journalisé est un **extrait littéral** du corps HTTP envoyé.
- **`+33 (0)6 12 34 56 78` n'était pas masqué** — la notation d'annuaire et de signature
  la plus courante en France, alors que `06 12 34 56 78` l'était. Corrigé, linéarité du
  motif vérifiée à la mesure (×4 pour une entrée ×4).
- **L'export CSV omettait `mode` et `applied`**, soit exactement ce qui distingue une
  suggestion d'une décision automatisée avec réponse publique — l'objet de l'article 22.
  Ajoutés en fin de ligne (les colonnes existantes gardent leur position).
- **`{"category": true}` devenait la catégorie #1, décision acceptée.** La frontière
  Pydantic n'était pas stricte. Elle l'est ; les chaînes numériques de certaines
  passerelles sont désormais coercées **explicitement dans l'adaptateur**, jamais un `bool`.

### 🟠 Sécurité — trois trous refermés

- **Aucune révocation de session** : le cookie survivait au logout **et** au changement de
  mot de passe. Seule parade en cas d'incident : changer `MASTER_KEY`, ce qui verrouillait
  toute la console. Ajout d'une génération de session vérifiée à chaque requête. Le logout
  ne révoque que si l'appelant portait une session — sinon l'endpoint public devenait un
  déni de service trivial.
- **Aucun journal d'audit des actions d'administration.** Nouvelle table `audit_log`
  alimentée depuis le point de passage unique, secrets masqués, **exclue de la purge
  RGPD** : la purger sur la fenêtre « tickets » aurait offert un effacement de traces
  trivial. *Limite connue : le passage d'une **entité** en `full_auto` transite par une
  autre couche et n'est pas encore audité.*
- **Politique de mot de passe contournable** : le minimum de 8 caractères n'était appliqué
  qu'au script, pas à l'amorçage paresseux — un mot de passe d'un caractère ouvrait la
  console.
- **`/health` était un amplificateur** : 5 requêtes vers le GLPI du client, sans
  authentification, et `?probe=true` ajoutait un appel LLM facturable. Cache de 15 s,
  `probe` réservé aux sessions admin, nouvel endpoint `/health/live` (process + base,
  zéro appel sortant) vers lequel pointent maintenant les healthchecks. Un `MASTER_KEY`
  incohérent donne un **503 explicite** au lieu d'un 500 opaque.
- **`/metrics` anonyme** révélait les connexions admin réussies et l'efficacité d'une
  force brute. Sans jeton configuré, il exige désormais une session ; avec jeton, le
  scrape machine reste anonyme (mode nominal Prometheus).

### 🟠 Exploitation

- **Aucun retour arrière praticable** : les `downgrade()` existaient mais rien ne les
  appelait, et `docs/install.md` promettait une procédure absente du script. Ajout de
  `--rollback [horodatage]` et `--list-backups`, avec déplacement de l'état courant,
  restauration conjointe base + clé, préservation du port publié. Un `trap` relance
  l'instance précédente si une mise à jour échoue — auparavant elle restait **à l'arrêt**.
- **Bug masqué depuis longtemps** : le test du port faisait `2>/dev/null` sur le shell
  courant, donc **toute** mise à jour perdait sa stderr — erreurs de `docker build` et
  messages de `die` compris.
- **Composes alignés** : rotation des logs et bornage CPU/mémoire manquaient sur la voie
  Portainer, pourtant recommandée — porte d'entrée du scénario « disque plein ».

### 🟡 Observabilité — le produit devient diagnosticable

- `PollStats` était **jeté après un log** : impossible de répondre à « pourquoi aucun
  ticket n'est trié ? » sans accéder aux logs du conteneur. Le dernier cycle est
  désormais persisté et exposé dans `/api/status` (bloc `last_poll`, **réservé à la
  réponse authentifiée**, message d'erreur masqué et borné).
- La console affiche « Dernier cycle : il y a 42 s — 12 vus, 3 triés, 9 déjà traités… »,
  signale un cycle trop ancien, et donne des indices couvrant les cinq causes réelles.
- **La tuile « Base de données : Saine » ne mentait plus** : c'était un affichage
  cosmétique sans aucune sonde. Elle rapporte ce qui est réellement mesurable.
- **Le fournisseur IA n'était jamais sondé** : « Configuré » signifiait « une clé
  existe ». La tuile indique maintenant « validité NON vérifiée » avec un test explicite
  à la demande — pas automatique, car c'est un appel facturé.
- **Export CSV en flux** : 20 000 appels journalisés faisaient un pic de **270 Mo** face
  à une limite conteneur de 512 Mo. Désormais **1,2 Mo**, sans troncature — un export
  d'audit tronqué vaut moins qu'un export lent.

### 🔴 Confronté à un vrai GLPI — deux défauts que les tests mockés ne pouvaient pas voir

Validé contre une instance **GLPI 11.0.7** réelle (193 tickets, dont **3 seulement au
statut « Nouveau »** — l'ordre de grandeur explique tout ce qui suit).

- **La lecture des tickets est enfin filtrée CÔTÉ SERVEUR** (`searchText[status]`) et
  triée du **plus ancien au plus récent**. Auparavant on lisait les N tickets aux ID les
  plus grands *tous statuts confondus*, puis on filtrait en Python : sur une instance
  réelle où l'écrasante majorité des tickets est close, la fenêtre se remplissait de
  tickets clos et pouvait ne renvoyer **aucun candidat** alors que des tickets attendaient
  d'être triés. Le tri ascendant fait par ailleurs passer **l'arriéré en premier** — le
  stock que le client attend justement de voir traiter le jour de la mise en service.
  `Content-Range` fournit désormais le total réel, donc une troncature **mesurée** plutôt
  que devinée. Le filtrage Python est conservé en ceinture : un GLPI plus ancien qui
  ignorerait `searchText` dégraderait la performance, jamais la correction.
- **Le masquage était mis en échec par l'encodage HTML de GLPI.** Les tickets sont stockés
  en HTML (éditeur TinyMCE) : balisage `<p>` et **entités**. Or l'éditeur insère `&nbsp;`
  automatiquement, et la typographie française place une espace insécable **avant les
  deux-points**. Mesuré sur des données réalistes :

  | Contenu tel que GLPI le stocke | Avant |
  |---|---|
  | `06&nbsp;12&nbsp;34&nbsp;56&nbsp;78` | **téléphone en clair** |
  | `mot de passe&nbsp;: Azerty1234` | **mot de passe en clair** |

  Ce n'est pas un cas tordu, c'est la forme **normale** d'un numéro ou d'un mot de passe
  collé dans un ticket français. Le texte GLPI est désormais normalisé en texte simple à
  la frontière de l'adaptateur — là où la représentation GLPI devient de la donnée du
  domaine — plutôt que d'apprendre le HTML aux motifs de masquage, qui doivent rester purs.
  Bénéfice second : le LLM reçoit `Je n'ai plus internet` au lieu de
  `Je n&#039;ai plus internet`, ce qui améliore le triage et économise des jetons.

### API GLPI V2 — validée contre l'instance réelle, mêmes défauts corrigés

L'accès OAuth2 (grant `password`) a permis de vérifier le connecteur V2, jusqu'ici jamais
éprouvé contre un vrai GLPI.

- **Le masquage y était mis en échec à l'identique.** L'API V2 renvoie exactement le même
  HTML que le legacy (`Je n&#039;ai plus internet`, `<p>…</p>`) : le `&nbsp;` faisait donc
  partir mots de passe et téléphones **en clair** au LLM, quel que soit le connecteur
  choisi. La normalisation est désormais **partagée** par les deux (`glpi/_text.py`) —
  la dupliquer aurait garanti qu'une copie dérive au prochain correctif, et une dérive
  ici, c'est de la PII qui fuit.
- **Tri passé en ascendant**, cohérent avec le legacy : l'arriéré d'abord. Le filtrage
  RSQL côté serveur (`filter=status.id==1`) était, lui, déjà correct.
- **Vérification croisée** : les deux connecteurs renvoient exactement les mêmes tickets
  sur la même instance, avec un texte normalisé identique. Un basculement d'API ne change
  donc plus ce qui part au LLM — ni ce qui est masqué.

### Suites de l'audit — imputabilité, troncatures visibles, documentation

- **Le passage d'une ENTITÉ en `full_auto` est désormais audité.** Il transitait par
  `referential_cache`, donc hors du traçage automatique de `RuntimeConfigService` : seul
  le défaut **global** était imputable. C'est pourtant l'action la plus lourde du produit
  — elle autorise l'IA à muter des Tickets et à **répondre publiquement** aux demandeurs.
  Une entrée par entité réellement modifiée (réécrire la liste sans rien changer ne noie
  pas le journal).
- **Les troncatures de lecture GLPI ne sont plus silencieuses.** Deux plafonds existent :
  la fenêtre des `POLLING_MAX_TICKETS` tickets les plus récents, et les 1 000 lignes de
  référentiels. Le premier fait qu'un **arriéré ancien n'est jamais trié** ; le second
  **rétrécit la whitelist**, et le moteur rejette alors des routages parfaitement
  légitimes en « à trier », sans que rien ne l'explique. Les deux journalisent désormais
  un avertissement nommant la cause et l'action à mener.
  *Le correctif de fond — filtre de statut côté GLPI et pagination réelle sur
  `Content-Range` — demande d'être validé contre une instance GLPI réelle (les API legacy
  et V2 n'exposant pas la même syntaxe) : il reste à faire, et la limite est documentée
  dans le code plutôt que découverte en production.*
- **Journalisation de la longueur d'un mot de passe refusé supprimée** (alerte CodeQL
  `py/clear-text-logging-sensitive-data`). Ce n'était pas la valeur, mais la longueur
  réduit l'espace de recherche d'une force brute — et un log part souvent vers un
  agrégateur au périmètre d'accès bien plus large que celui du `.env`.

### Documentation — les écarts relevés par l'audit sont refermés

- **`docs/dpo.md`** : les **noms des techniciens et leurs fiches en prose** partent au LLM
  à chaque appel, non masqués (ce sont des données personnelles de salariés, hors UE si
  OpenAI/Anthropic est activé) ; le journal `llm_calls` ne contient que le contenu du
  ticket, donc le prompt réel **n'est pas reconstituable** ; **trois tables échappent à la
  purge** (`processed_tickets`, `referential_cache`, `audit_log`), chacune avec sa raison ;
  et les colonnes `mode`/`applied` de l'export sont rattachées à l'**article 22**.
- **`SECURITY.md`** : « aucun secret en clair dans `.env` » était faux — `.env` porte par
  conception la `MASTER_KEY` et le mot de passe d'amorçage ; la garde anti-SSRF est
  **désactivée pour GLPI dans la configuration livrée** (`GLPI_ALLOW_PRIVATE=true`, sans
  quoi un GLPI on-premise serait injoignable) ; ajout de la révocation de session et du
  journal d'audit.
- **`docs/install.md`** : `--rollback`, `--list-backups`, `ITSM_ALLOW_NEW_MASTER_KEY`,
  `ITSM_IMAGE_TAG`, `/health/live`, et surtout **pourquoi il ne faut jamais copier
  `itsm.db` seul à chaud** (mode WAL : le fichier peut être vide ou corrompu, sans erreur).

### Tests

**389 → 492 pytest** (verts sur 3.13 **et** 3.14) et **89 → 111 Vitest**. Chaque
correction a un test vérifié **rouge avant, vert après**. Aucun test existant affaibli.

## 2026-08-08 — 0.9.47 — Honnêteté des claims, bornes mémoire et remise à niveau complète

Revue complète du dépôt (architecture, sécurité, doc, CI) **et remise à niveau de toute
la chaîne de dépendances**. Le cœur de triage n'a pas bougé : cette version corrige des
**promesses de documentation devenues fausses**, deux **garde-fous trop laxistes**, et
remet l'ensemble des composants à jour. Aucun changement de comportement du moteur.

### Dépendances — remise à niveau intégrale

Point de départ : `pip-audit` remontait **8 avis** sur 3 paquets et `npm audit` **9
vulnérabilités dont 1 critique**. Après la montée, les deux audits sont **vides**.

- **Backend** : `cryptography` 48 → **50** (deux majeures ; c'est le chiffrement Fernet au
  repos et la vérification Ed25519 des licences), `starlette` 1.1 → **1.5**, `fastapi`
  0.136 → 0.141, `uvicorn` 0.48 → 0.52, `pydantic-settings` 2.14 → 2.15, `sqlmodel`,
  `alembic`, `sqlalchemy`, `apscheduler`, `prometheus-client`, plus l'outillage de dev
  (`pytest` 9.1, `pytest-asyncio` 1.4, `ruff` 0.16).
- **Rupture silencieuse rattrapée — FastAPI 0.138** : `include_router()` **n'aplatit plus**
  les routes dans `app.routes`. Deux endroits en dépendaient sans le dire :
  `api/metrics.py` (label `path` templaté des métriques Prometheus) serait tombé sur
  `<other>` pour **toutes** les requêtes, et `/api/debug/info` aurait renvoyé une liste
  d'endpoints **vide**. Les deux passent désormais par `iter_route_contexts()`, l'API
  publique prévue pour ça, et le plancher est relevé à `fastapi>=0.138` — sous cette
  version, le code ne fonctionne tout simplement plus.
- **Frontend** : `biome` 1.9 → **2.5** (migration de configuration), `vite` 6 → **8**,
  `vitest` 2 → **4**, `typescript` 5.9 → **7**, `@vitejs/plugin-react` 4 → 6, `jsdom`
  29 → 30, `lucide-react` 0.460 → **1.30**, `tailwind-merge` 2 → **3** (la v2 ciblait
  Tailwind 3 alors que le projet est en Tailwind 4 — c'était la v2 qui était le mauvais
  choix), plus React, React Router, Playwright et les types.
- **Outillage & images** : `uv` 0.11.25 → **0.12.3**, image `node` 22 → **24**, image
  `python` 3.13 → **3.14**, actions GitHub aux dernières majeures (`checkout` v7,
  `setup-python` v7, `setup-node` v7, `upload-artifact` v7, `setup-uv` v9).
- **Python 3.14** : la suite complète (380 tests, extras `postgres` inclus) a été rejouée
  sur 3.14.5 **avant** le bump de l'image. `requires-python` reste à `>=3.13` : c'est
  l'image livrée qui avance, pas le socle minimal supporté.

Deux montées ont été **volontairement refusées**, contre l'intuition du « tout mettre à
jour » :

- **Node 26** : les majeures paires deviennent LTS, mais 26 ne le devient que le
  **2026-10-28**. Livrer une ligne « Current » dans une image de production n'a pas de
  sens ; on reste sur **Node 24**, LTS active jusqu'en avril 2028.
- **PostgreSQL 18** : un changement de majeure PostgreSQL **n'est pas un bump d'image**.
  Les fichiers d'un cluster PG 16 sont illisibles par une majeure supérieure — le
  conteneur refuserait de démarrer sur un `data/postgres/` existant. Le tag reste en
  **16-alpine** (supportée jusqu'en 2028, correctifs de sécurité inclus), avec la
  procédure de migration `pg_dump`/restauration documentée dans le compose, ainsi que le
  piège du `PGDATA` déplacé par l'image officielle PG 18.

### Sécurité — anti brute-force

- **Table du rate-limiter de login BORNÉE** (`api/ratelimit.py`). La table des clés (une
  entrée par IP cliente) n'était jamais purgée : sous `TRUST_PROXY_HEADERS=true`, la clé
  vient de `X-Forwarded-For`, donc un attaquant faisant varier cet en-tête faisait croître
  la mémoire du process sans limite. Ajout d'une purge des entrées mortes (aucun échec
  dans la fenêtre, aucun blocage actif) amortie sur les écritures, plus un **plafond dur**
  (`_MAX_ENTRIES = 10 000`). **Un blocage actif n'est JAMAIS évincé** : saturer la table
  d'IP bidon ne permet donc pas de se débloquer. Sémantique du limiteur inchangée (seuils,
  durées, `retry_after`, `reset`).

### Sécurité — fuites de masquage introduites par le correctif ReDoS, refermées

Le correctif ReDoS (ci-dessous) avait borné les quantificateurs « au plus juste ». Une
revue de code a montré que ces bornes créaient **trois fuites de PII** — exactement ce
que le masquage existe pour empêcher. Corrigées, avec un test de non-régression chacune.

- **Mot de passe non masqué sur du texte aligné.** Avec `\s{0,8}`, un simple collage
  depuis un formulaire ou un tableau — `Mot de passe<9 espaces>:<9 espaces>Azerty1234` —
  laissait le mot de passe partir **en clair au LLM**. La bonne réponse n'était pas de
  borner au plus juste mais de supprimer l'**ambiguïté** du motif (`(?:[:=]\s{0,32})?`
  au lieu de `[:=]?\s{0,32}`, ce qui interdit les découpes multiples d'un même blanc)
  puis de borner **largement** (32). Les alignements passent, le coût reste linéaire.
- **Adresse e-mail à partie locale longue non masquée.** La borne à 64 (limite RFC 5321)
  était « correcte » mais fausse en pratique : une adresse de 70 caractères s'écrit très
  bien dans un ticket, et comme le motif est ancré sur `\b`, dépasser la borne ne masque
  pas **du tout** l'adresse au lieu de la masquer partiellement. Borne portée à 256.
- **SIREN valide non masqué quand il est suivi d'un nombre à 5 chiffres.** Le motif
  gourmand capturait les 14 chiffres d'un coup (`SIREN 123456782 12345 unités`), échouait
  à Luhn, et le scan reprenant après le match, le SIREN valide des 9 premiers chiffres
  n'était jamais réessayé. Ajout d'un repli explicite sur le préfixe de 9.

### Sécurité — déni de service par expression régulière (ReDoS)

- **Deux motifs de masquage étaient à backtracking quadratique** (`domain/masking.py`) et
  atteignables par le **contenu d'un ticket**, donc par le demandeur : `_EMAIL_RE`
  (`[\w.+-]+@…` sur un texte sans arobase) et `_SECRET_KEYWORD_RE` (`…\s*[:=]?\s*`, deux
  quantificateurs illimités adjacents). Mesuré avant correctif : `password` + 32 000
  espaces = **5,7 s de CPU**, avec une croissance ×4 à chaque doublement de l'entrée.
  Le masquage étant appelé **synchronement depuis une coroutine**, un seul ticket gelait
  l'event loop — donc l'API *et* le poller. Quantificateurs désormais **bornés** (limites
  RFC 5321 pour l'e-mail) : même charge à **6,5 ms**, croissance linéaire, masquage
  inchangé. Test de non-régression sur la **propriété** (linéarité), pas sur un seuil en
  millisecondes qui serait instable en CI.
  *La seconde occurrence (`_EMAIL_RE`) n'avait pas été signalée par l'analyse statique ;
  elle a été trouvée en mesurant chaque motif du module.*

### Sécurité — surface d'attaque

- **Vérification de version : garde anti-SSRF rendu inconditionnel** (`routes/version.py`).
  `update_check_url` n'est **écrivable par aucune route** (la clé n'est pas un champ de
  `ConfigUpdate`, l'UI ne l'expose pas) : sa seule source est la variable d'environnement
  `UPDATE_CHECK_URL`, qui arrive par `Settings` **sans passer** par la validation de
  `RuntimeConfigService.set()`. Le seul contrôle restant était donc la résolution DNS des
  `event_hooks`, elle-même conditionnée à `ssrf_guard_enabled` — flag qu'un opérateur peut
  désactiver pour une cible GLPI/LLM on-premise. Un `.env` pointant `169.254.169.254`
  partait alors sans aucun contrôle. La validation (schéma `https`, hôte public routable)
  est désormais refaite **au point d'appel**, quel que soit le flag.
  *À noter : ce n'est pas un vecteur d'élévation de privilèges — qui peut écrire le `.env`
  contrôle déjà le process. C'est une protection contre l'erreur de configuration, et
  contre un futur endpoint qui rendrait la clé modifiable.*
- **`/api/debug/diagnostics` : détails d'exception masqués et bornés**. Le endpoint
  (admin authentifié **et** `DEBUG_TOOLS_ENABLED`, livré à `false`) renvoyait `str(exc)`
  brut, or une erreur de transport LLM embarque jusqu'à 500 caractères du corps renvoyé
  par le fournisseur. Le message reste diagnostiquable mais passe par le masquage PII du
  produit et est borné à 300 caractères.

### Qualité du masquage (feature Supporter)

- **NIR / SIREN / SIRET validés par leur clé de contrôle** (`features/pii_advanced.py`) :
  Luhn pour SIREN/SIRET (règle INSEE), `97 - (numéro mod 97)` pour le NIR. Auparavant
  **toute** suite de 9, 14 ou 15 chiffres était caviardée en `[SIRET]` / `[NIR]` — un
  numéro de ticket, de série ou une référence fournisseur disparaissait du prompt envoyé
  au LLM, dégradant la qualité du triage. Un candidat dont la clé est invalide est
  désormais **laissé tel quel** (même contrat que la validation Luhn des cartes du cœur).
  Exception connue et assumée : les SIRET de La Poste (SIREN `356000000`) ne suivent pas
  Luhn et ne sont pas masqués.

### Documentation — claims corrigés (le produit se vend sur son honnêteté)

- **Fin du « aucun phone-home / aucun appel sortant »**. La vérification de version est
  **activée par défaut** (opt-**out**) depuis plusieurs versions et interroge
  `api.github.com`. L'affirmation absolue figurait dans `README.md`, `SECURITY.md`,
  `docs/dpo.md`, `docs/architecture.md` et `docs/guide-fonctionnement.md` (qui la
  qualifiait encore d'« opt-in »). Ces documents décrivent maintenant l'inventaire exact
  des sorties réseau et, pour la vérification de version : URL appelée, déclencheur
  (chargement de la console par un **admin authentifié**, jamais de tâche de fond),
  fréquence (cache 1 h), **données transmises : aucune**, et la coupure air-gap
  (`UPDATE_CHECK_URL=` vide). La **licence Supporter reste vérifiée 100 % hors-ligne** —
  cette garantie-là est inchangée et clarifiée.
- **`docs/dpo.md`** : fiche opposable de la vérification de version à consigner au
  registre ; mention explicite du **titre de ticket conservé en clair** dans le Journal de
  décision (`subject`, non masqué, rétention 365 j, **exclu** de l'export CSV DPO).
- **`SECURITY.md`** : la 2FA TOTP était annoncée « codée mais désactivée » alors qu'aucune
  ligne n'existe dans le produit → requalifiée **« en alpha — non implémentée à ce jour »**,
  à ne pas présenter comme un contrôle disponible en audit.
- **`SECURITY.md`** : nouveau risque résiduel assumé — **fenêtre d'idempotence** (le poller
  marque `processed` après l'action) : un arrêt brutal entre la mutation GLPI et ce
  marquage peut produire une seconde mutation et une seconde réponse **publique**, en
  modes `semi_auto`/`full_auto` uniquement ; impact nul en `suggestion` (défaut).
- **`persistence/tables.py`** : la docstring de `ProcessedTicket` promettait une
  re-vérification côté GLPI avant écriture qui n'a jamais été implémentée — remplacée par
  la description honnête de la fenêtre et de son impact par mode.
- **`api/routes/version.py`** : docstring « OPT-IN, URL vide par défaut » corrigée en
  « OPT-OUT » avec les garde-fous réels et les formats de flux acceptés.
- **Les conventions internes** : la règle de release pointait les releases GitLab comme déclencheur de
  la notification de MAJ ; le défaut du code est le flux **GitHub** `releases/latest`.
- **`docs/testing.md`** : compteurs de tests remis à jour (**376** pytest, **89** Vitest) +
  documentation de la CI GitHub, qui n'y figurait pas.
- **`.env.example`** : `UPDATE_CHECK_URL` documenté avec sa valeur par défaut, son
  caractère opt-out et la procédure air-gap.

### Outillage — automatisations GitHub

- **Renovate** (`renovate.json`) : mises à jour de dépendances groupées (Python/uv, npm
  prod, npm dev, GitHub Actions, images de base), alertes de vulnérabilité prioritaires,
  `lockFileMaintenance` hebdomadaire. Auto-merge volontairement limité aux **patchs de
  devDependencies npm** et aux **digests d'actions** : aucune dépendance runtime
  (`cryptography`, `pydantic`, `fastapi`, `react`…) n'est mergée sans relecture humaine.
  Point clé : `rangeStrategy: update-lockfile` sur le manager `pep621`, sans quoi Renovate
  resterait muet côté Python (toutes les deps sont déclarées en planchers `>=`, donc déjà
  satisfaites par toute version nouvelle).
- **CodeQL** (`codeql.yml`) : analyse statique Python + TypeScript sur PR, push `main` et
  hebdomadaire, en `build-mode: none`.
- **Scan de secrets** (`secret-scan.yml`, `.gitleaks.toml`) : gitleaks **bloquant** sur PR.
  Allowlist par **valeur exacte** (clé Ed25519 de test, jeton de licence factice,
  placeholder AWS de la doc) et non par exclusion de `tests/**`, qui créerait un angle mort.
- **Audit de dépendances** (`security-audit.yml`) : portage des jobs `pip-audit` et
  `npm audit` du GitLab, **non bloquant** (comme leur `allow_failure`) mais visible (résumé
  de job, annotation, artefact 30 j).
- **Release automatisée** (`release.yml`) : un tag `vX.Y.Z` crée la release GitHub avec les
  notes extraites du CHANGELOG (repli sur les notes générées si la section est absente),
  après vérification que `pyproject.toml`, `__init__.py` et `api.ts` portent bien la même
  version. Gère le fait qu'une release créée par le `GITHUB_TOKEN` ne déclencherait pas les
  workflows en aval.

### Divers

- `.gitignore` : sorties de `coverage.py` (`.coverage`, `.coverage.*`, `htmlcov/`,
  `coverage.xml`) ignorées — un `.coverage` traînait à la racine, exposé à un commit
  accidentel.
- Tests : **+13** (purge et plafond du limiteur, non-contournement d'un blocage par
  saturation, clés de contrôle NIR/SIREN/SIRET, non-régression des patterns custom,
  linéarité du masquage sur entrées pathologiques). Total **380 pytest** + 89 Vitest.

## 2026-07-02 — 0.9.46 — Durcissement du cœur de triage (audit approfondi)

### Sécurité — garde-fous du moteur
- **Contournement de whitelist fermé (FR-7)** : un `technician_id` proposé par le LLM hors
  périmètre, accompagné d'un groupe éligible, n'est plus jamais appliqué à GLPI. La mutation
  et le Journal utilisent la même assignation filtrée (`whitelist.effective_assignment`) —
  fin du trou d'audit et du vecteur d'injection de prompt en mode automatique.
- **Dépense LLM bornée** : toute réponse LLM 200 malformée (`content: null`, `usage: null`,
  corps HTML d'un portail captif) devient une erreur typée `LlmResponseError` — plus de
  boucle de re-facturation invisible au plafond de coût. Les erreurs de sortie invalide sont
  désormais retentées (FR-9).
- **Périmètre vide** : si aucune catégorie n'est sélectionnée, le polling saute le cycle sans
  consommer les tickets ni lancer d'appel LLM au rejet garanti (l'arriéré est préservé).
- **Intégrité de l'audit** : une décision appliquée à GLPI est toujours journalisée, même si
  l'écriture du Suivi échoue ensuite (plus de mutation « fantôme » ni de doublon de réponse).

### Sécurité — surface & configuration
- **GLPI on-premise** : nouveau flag `GLPI_ALLOW_PRIVATE` (défaut `true`) autorisant une
  cible GLPI sur IP/hôte privé, sans relâcher la garde SSRF pour le LLM et le vérificateur
  de mises à jour.
- **Retrait de licence effectif** : « retirer la clé » re-verrouille en Community même
  lorsque `LICENSE_KEY` est fourni par l'environnement (sentinelle interne).
- **Plafond de coût fiable après changement de fournisseur** : les prix €/token sont
  éditables depuis la console (plus besoin d'éditer le `.env` du conteneur).
- **Sandbox** : soumise au plafond de coût (409 si atteint) et journalisée comme les appels
  réels ; en-têtes durcis ; `session_is_authenticated` aligné sur le fail-closed ;
  rate-limit login non contournable par un X-Forwarded-For trop court ; SQLite en WAL +
  `busy_timeout` (moins de « database is locked ») ; borne sur `GET /api/decisions?limit`.

### Console
- Formulaires de configuration : les valeurs (dont les secrets) d'un mode/fournisseur
  abandonné ne sont plus envoyées à l'insu de l'opérateur ; le bouton Enregistrer est
  inactif tant que la configuration n'est pas chargée ; erreurs réseau affichées au lieu
  d'être avalées ; anti double-soumission ; message de login discriminant (panne ≠ mauvais
  mot de passe).

### Site & docs
- Landing : navigation mobile, langue correcte au rendu serveur (FR pour un visiteur FR),
  ancres de la page tarifs réparées, accessibilité (skip-link).
- Docs : correction d'affirmations fausses (masquage IBAN/secrets = Supporter et non
  Community ; purge RGPD active par défaut ; anti-brute-force login ; Python 3.13) ;
  `UPDATE_CHECK_URL`/`TRUST_PROXY_HEADERS` documentés ; note de ré-émission des licences
  antérieures à la 0.9.44.

## 2026-07-02 — 0.9.45 — Correctifs de revue post-0.9.44

### Corrigé
- **Boucle de redirection au login en fail-closed** : quand aucun mot de passe admin
  n'était configuré (ou MASTER_KEY incohérente), la console bouclait /login → / → 401.
  `/api/auth/status` reflète désormais les règles d'accès réelles (`authenticated`
  couvre `dev_open_admin`), la page de connexion affiche un bandeau explicite
  (« définissez ITSM_ADMIN_PASSWORD ») et une ceinture anti-boucle protège la
  redirection automatique.
- CSP : `/docs/oauth2-redirect` (Swagger) exempté comme `/docs` et `/redoc`.
- `docs/install.md` : `-e SESSION_HTTPS_ONLY=false` ajouté au `docker run` durci
  (login impossible en HTTP sinon) ; formulation du défaut harmonisée partout
  (« défaut code `true`, artefacts livrés `false` »).
- Console : garde manquante sur le coût 24 h de la page Statut ; anti-course
  `useResource` renforcé au démontage ; `detail` string (style FastAPI) accepté
  dans les messages d'erreur.
- `anyio` déclaré explicitement dans les dépendances (importé directement).
- Hygiène du dépôt public : hostnames d'exemple neutres dans les tests, commentaires
  pointant des documents internes reformulés, en-tête de `bootstrap.sh` réécrit
  (voie « depuis les sources »).

## 2026-07-01 — 0.9.44 — Durcissement global (audit multi-agents)

### Sécurité
- **Fixtures de licence re-signées avec une paire Ed25519 de TEST dédiée** : plus aucun
  jeton signé par la clé de production dans le dépôt (un jeton Supporter valide et
  perpétuel était committé dans les tests — fuite corrigée) ; les jetons de test sont
  générés à la volée et un test-canari garantit qu'ils ne valident jamais contre la clé
  publique embarquée du produit.
- **En-têtes de sécurité HTTP** sur toutes les réponses (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`), CSP restrictive sur le HTML
  de la SPA, HSTS quand `SESSION_HTTPS_ONLY=true`.
- **`/api/status` à deux niveaux** : sans authentification, seul l'état de marche est
  exposé (ok, version, polling) ; compteurs LLM, coût 24 h et volumétrie exigent une
  session valide.
- **Garde SSRF non bloquant** : la résolution DNS anti-rebinding est déportée dans un
  thread (`anyio.to_thread`) — l'event loop ne gèle plus pendant les appels sortants ;
  hooks httpx factorisés (`adapters/ssrf.py`).

### Ajouté
- **Publication GHCR gatée** : ruff + pytest puis **smoke-test réel de l'image** (boot,
  `/health`, `/api/status`, amorçage admin vérifié dans les logs) avant tout push
  multi-arch ; job build Docker sur PR dans la CI.
- **`HEALTHCHECK` dans l'image** (voie `docker run` couverte, les composes gardent le leur).
- **Backoff sur le retry LLM** (0,5 s puis 1,5 s) — un 429 n'est plus re-frappé immédiatement.
- Tests du garde open-core `require_feature` (403 `feature_locked` sans licence).
- **Installeur curl durci** : détection d'une installation « depuis les sources »
  (bind mount `./data`) avant écrasement, backup `docker-compose.yml.bak` à la mise à
  jour, messages explicites sur mot de passe trop court / à caractères spéciaux,
  aide en cas d'échec de pull GHCR, override `ITSM_DIR`.

### Modifié
- **Image Docker allégée de ~36 %** (170 → 109 MB) : fin du `chown -R` dupliquant le venv,
  cache uv monté au build, couche de dépendances stable (le code ne l'invalide plus).
- L'entrypoint ne re-chown plus tout `/app/data` à chaque boot et **préserve `postgres/`**
  (PGDATA du compose « sources »).
- Frontend : réponses non-JSON traduites en erreur propre, **redirection login sur session
  expirée (401)**, messages d'erreur centralisés et bilingues, commande de mise à jour de
  la page Supporter adaptée au runtime (Docker vs hôte), anti-course dans `useResource`,
  toasts d'erreur affichés 6 s.
- `/api/status` et `/api/metrics` reflètent les **overrides runtime** (polling, plafond
  de coût) au lieu des seules variables d'env ; `DASHBOARD_MAX_TICKETS` honoré en GLPI legacy.
- Docs : `-e SESSION_HTTPS_ONLY=false` ajouté aux exemples `docker run` (login HTTP
  impossible sinon) ; canal d'obtention de licence (`support@itsm-modern-ai.com`) indiqué.
- SECURITY.md et catalogue in-app alignés : « regex custom / règles par entité » = roadmap.

## 2026-06-28 — 0.9.43 — Correctifs sécurité / CI (XFF, SECURITY.md, CI GitHub)

### Sécurité
- **X-Forwarded-For — anti-spoofing** : `client_ip` prend l'IP de confiance posée par le
  proxy (N-ième en partant de la **droite**, `trusted_proxy_hops` configurable, défaut 1)
  au lieu de la valeur de gauche contrôlée par le client. Ferme un contournement du
  rate-limit login FR-24 derrière un reverse proxy.

### Ajouté
- **CI GitHub** (`.github/workflows/ci.yml`) : ruff + pytest + build frontend sur push/PR
  (la CI complète — e2e, scans deps — reste sur GitLab).
- `docker/entrypoint.sh` accepte **`ADMIN_PASSWORD`** comme alias de `ITSM_ADMIN_PASSWORD`.

### Modifié
- **`SECURITY.md` publié sur le mirror GitHub** (politique de divulgation : contact,
  périmètre, délais) — il n'est plus strippé.
- **Dockerfile** : image `uv` épinglée (`0.11.25`) — fin de la contradiction « build reproductible » vs `latest`.

## 2026-06-28 — 0.9.42 — Indicateur runtime (Docker / hôte) + MAJ adaptée

### Ajouté
- **Indicateur de runtime** dans le top bar (à côté de la version) : pastille **Docker**
  (conteneur) ou **Hôte** (installé direct). Détection via `ITSM_RUNTIME` (gravé dans
  l'image) avec repli `/.dockerenv` / cgroup ; exposé par `/api/version` (champ `runtime`).
- **Notification de MAJ adaptée au runtime** : l'infobulle propose la bonne commande
  (`docker compose pull && docker compose up -d` en conteneur, `./install.sh --update` sur l'hôte).

## 2026-06-28 — 0.9.41 — Déploiement orchestrateur : image GHCR pull-only + amorçage admin au boot

### Ajouté
- **Image publique GHCR** `ghcr.io/wicaebeththeo/itsm-modern-ai` (multi-arch amd64+arm64),
  publiée par `.github/workflows/docker-publish.yml` (push `main` + releases).
- **`docker-compose.portainer.yml`** : stack « pull-only » durci (named volume `itsm_data`)
  à coller dans Portainer / Komodo / Dockge / `docker compose`.
- **Installeur one-liner** `curl -fsSL https://itsm-modern-ai.com/install | bash` : installe
  Docker, écrit le compose + `.env`, amorce l'admin, démarre — sans clone ni build.
- **Amorçage admin au boot** : `docker/entrypoint.sh` crée le compte admin depuis
  `ITSM_ADMIN_PASSWORD` (idempotent via `admin_setup --check`, jamais `--force`) → la console
  n'est plus verrouillée sur un déploiement par image nue (Portainer / `docker run`).

### Modifié
- `docker-compose.yml` : passthrough `ITSM_ADMIN_PASSWORD`.
- Docs (déploiement, Portainer, `docker run`, MAJ `docker compose pull && up -d`), README et
  site : `install.sh` rétrogradé en voie « depuis les sources / hors-ligne (airgap, `--bundle`) ».

## 2026-06-24 — 0.9.4 — Hotfix installeur (daemon, bash, env) + correctifs UI

- **Installeur** : attend désormais que le **daemon Docker** soit prêt (boucle + diagnostic
  socket/LXC) au lieu d'échouer sur un `docker info` prématuré ; correctif `env
  DEBIAN_FRONTEND=noninteractive` (l'install apt cassait en root quand `$SUDO` est vide).
- **One-liner `curl … | sh`** : installe **bash** en plus de git si absent — `install.sh` est
  un script bash, le clone+exec échouait sur une VM minimale sans bash.
- **UI** : le bouton « Offrir un café » était masqué pour **tout le monde** sur l'image unique
  (test sur `installed`, toujours vrai) → corrigé sur `active` (licence réellement active) ;
  le lien « notes de version » de la page Supporter renvoyait vers un 404 GitHub → pointe
  désormais sur **docs.itsm-modern-ai.com/update**.
- **Mirror GitHub** : `.gitlab-ci.yml` retiré du dépôt public (inerte sur GitHub, exposait
  l'infra GitLab) ; le CI reste sur GitLab.

## 2026-06-23 — 0.9.3 — Installeur : installe TOUS les prérequis (git + Docker + compose)

- Le one-liner `curl … | sh` **installe git** s'il manque (avant le clone), puis `install.sh`
  **installe Docker et le plugin compose** s'ils manquent — l'installation fonctionne sur une
  VM nue.
- `ask()` lit le terminal via `/dev/tty` (donc les confirmations marchent sous `curl | sh`),
  **défaut = oui**, et en mode non-interactif (CI) installe automatiquement les prérequis.
- Annonce Discord automatique des nouvelles releases (workflow GitHub).

## 2026-06-23 — 0.9.2 — Maj : lien doc, check par défaut, message port 8000

- **UI** : correction du lien `GITHUB_URL` (org `tmeneboode` → `WicaebethTheo`, ne 404 plus) ;
  le badge « mise à jour disponible » renvoie vers la **doc de mise à jour**
  (docs.itsm-modern-ai.com/update).
- **Vérification de mise à jour activée par défaut** (best-effort, lit seulement le dernier
  numéro de version publié, aucune donnée envoyée) ; air-gap = `UPDATE_CHECK_URL=` vide.
- **Installeur** : si le port 8000 est pris mais qu'aucune instance n'est dans le dossier
  courant, message clair → se placer dans le dossier de l'instance pour la mettre à jour.

## 2026-06-23 — 0.9.1 — Installeur on-prem robuste + correctifs UI

- **Installeur via `curl … | sh`** : le mot de passe admin est désormais lu depuis `/dev/tty`
  (fonctionne avec le one-liner) ; le message final affiche l'URL avec l'**IP de la machine**
  (+ localhost). `docker compose up -d --force-recreate` remplace un conteneur périmé dont le
  montage `./data` aurait été supprimé. `.env.example` et `docker-compose.yml` réécrits en ASCII
  (fin du charabia sur les terminaux non-UTF-8) et allégés.
- **UI** : correction du double badge « Supporter » (bouton + badge) quand une licence est active.

## 2026-06-23 — 0.9.0 — Édition unique : fonctions Supporter intégrées, déverrouillées en collant une licence dans la page Supporter

Édition **unique** : un **seul dépôt, une seule image** qui contient désormais tout le
code, y compris les fonctions **Supporter** — livrées dans l'image mais **gatées par
licence**. On les déverrouille **en place** en collant une clé de licence signée dans la
**page Supporter** de la console.

- **Features Supporter intégrées** : `pii_advanced` (masquage NIR/SIRET + patterns custom),
  `multi_entity` (résolution hiérarchique des politiques) et `scheduled_exports` (exports
  planifiés) vivent maintenant dans `src/itsm_modern_ai/features/`. `build_registry()` les
  enregistre toujours (code **installed**) ; elles ne s'**activent** qu'avec une licence
  valide (**entitled**) — `active = installed ∧ entitled`.
- **Concept Supporter** : édition `"supporter"`, propriété `is_supporter`, libellés/messages
  403 et page dédiée. Les clés de features, le préfixe de jeton `itsm-lic` et la clé publique
  de vérification Ed25519 sont **inchangés**.
- **Une seule image** : `docker-compose.yml` utilise un tag fixe `itsm-modern-ai:latest`.
  Déverrouillage **en place** depuis la **page Supporter** (coller / retirer la clé) ;
  `LICENSE_KEY=…` dans `.env` reste un pré-amorçage optionnel pour les déploiements automatisés.
- **Activation 100 % UI** : tout passe par la page Supporter (coller la clé pour activer,
  la retirer pour revenir à Community). Aucune ligne de commande requise ; données intactes.
- **Sécurité** : la clé **privée** de signature des licences reste dans le dépôt privé de
  signature des licences ; seule la vérification (clé publique) est ici.

## 2026-06-09 — 0.8.14 — Durcissement sécurité (audit)

Corrections issues d'un audit cybersécurité complet — aucun changement du pipeline de triage :

- **XSS stocké (HIGH)** : le brouillon LLM (sortie non fiable, prompt-injectable) est
  désormais **échappé HTML** avant dépôt en Suivi GLPI, en mode public (réponse au
  demandeur) comme privé (lu par le technicien) — `render_followup` dans `services/triage.py`.
- **Docs API exposées (MED)** : `/docs`, `/redoc`, `/openapi.json` **désactivées par
  défaut** (le schéma complet, noms de champs secrets compris, n'est plus public sans auth).
  Réactivables en dev via `EXPOSE_API_DOCS=true`.
- **SSRF (MED)** : le vérificateur de mise à jour passe par le **même garde anti-rebinding**
  (par saut de redirection) que les clients LLM/GLPI, et `update_check_url` est **validée à
  la sauvegarde** (rejet loopback/IP privée/metadata cloud).
- **Cookie de session** : expiration absolue (défaut 12 h, `SESSION_MAX_AGE_SECONDS`).
- **Licence** : borne de taille du jeton (8 Ko) côté API et domaine → pas de parse coûteux.
- **Fail-open masquage (Supporter)** : alerte WARNING par cycle quand `pii_advanced` est
  **installé mais non licencié** (le masquage IBAN/secrets retombe sinon en silence).
- **Hygiène** : `install.sh` pose `chmod 600` sur `.env` ; rappel de retrait d'`ADMIN_PASSWORD`.

## 2026-06-01 — 0.8.13 — Background atmosphérique + démo statique hébergeable

Travail frontend, sans changement de comportement métier :

- **Fond de la console** : le backdrop n'est plus un aplat. Mesh indigo multi-couches
  (sobre, palette « Operator Preview »), **grain** SVG subtil en overlay et halo discret en
  haut de la zone de contenu — entièrement en CSS, **sous** le contenu (`pointer-events:none`,
  `z-index` maîtrisés), respect de `prefers-reduced-motion`. Le Login reçoit le même backdrop.
- **Démo hébergeable hors produit** : nouveau flag de build **`VITE_DEMO=true`** qui force le
  mode démo (données mockées `demo.ts`, zéro backend) **quel que soit le chemin** — la démo
  n'est plus liée à la route `/demo`. Permet un build statique servi à la racine d'un
  sous-domaine dédié (cf. dossier `ITSM-Modern-Ai-Demo`). Le `basename` du routeur s'adapte :
  racine pour le build dédié, `/demo` pour la démo in-product, inchangé pour l'app réelle.
- **Langue par défaut = EN au premier démarrage** : sans préférence stockée, la console
  s'ouvre désormais en anglais (seul un choix explicite « fr » bascule en français) ;
  `index.html` passe en `lang="en"`. La locale des tests est figée sur `fr` pour conserver
  les assertions existantes ; le nouveau défaut est couvert par `i18n.test.tsx`.

## 2026-05-31 — 0.8.12 — Audit 4 agents : honnêteté DPO + accessibilité

Corrections suite à la revue multi-agents de la 0.8.11 :

- **Honnêteté DPO (bloquant)** : la catégorie **« patterns regex personnalisés »** était
  affichée *Actif/Masqué* en Supporter alors qu'aucun motif n'est configurable (la capacité
  `AdvancedPiiMasker.from_rules` existe mais n'est pas exposée). Elle passe en statut **« À
  venir »** (scope `roadmap`, jamais active) dans la page, le rapport DPO et la doc — pour ne
  pas tromper la DPO. NIR/SIRET reste réellement masqué.
- **Accessibilité** : la jauge de la page Coûts reçoit `role="progressbar"` + `aria-valuenow/
  min/max/valuetext` (la valeur du quota est désormais annoncée aux lecteurs d'écran).
- **Cohérence démo** : rétention du mock alignée sur les vrais défauts (**365 j décisions /
  90 j appels LLM**, au lieu de 30/30) ; catalogue Store de démo resynchronisé sur le vrai
  catalogue (libellé **« Masquage PII avancé »** au lieu de « (NER) » — la NER n'est pas
  implémentée — et features à venir marquées « (à venir) »).
- NITs front : `CostQuotas` utilise `useLang()` (au lieu de détourner `t()`), `t()` redondant
  retiré dans `Privacy`.

## 2026-05-31 — 0.8.11 — Console DPO + page Coûts & quotas

- **Nouvelle page « Confidentialité (DPO) »** (`/privacy`) destinée à la DPO/RSSI :
  tableau des catégories PII avec leur statut **réel selon la licence** (email + téléphone
  masqués sans licence ; IBAN/cartes, secrets/tokens/clés API, IP/MAC, NIR/SIRET et
  patterns regex custom **verrouillés · Supporter**), bandeau d'avertissement honnête en
  Community (ces motifs transitent et sont journalisés **en clair**), **outil « Tester le
  masquage »** (applique le masquage réel à un texte), lien vers le journal `llm_calls`,
  rappel des durées de rétention, et **export d'un rapport DPO** (`GET /api/privacy/report.md`).
- **Nouvelle page « Coûts & quotas »** (`/cost`) : dépense LLM des dernières 24 h vs plafond
  journalier glissant (jauge colorée + alerte de dépassement), nombre d'appels journalisés
  et tarifs configurés. Lecture seule (le plafond se règle dans « Moteur »).
- **Backend** : routes `GET /api/privacy`, `POST /api/privacy/test-mask`,
  `GET /api/privacy/report.md`, `GET /api/cost` (protégées par l'auth locale).
- **Cohérence masquage** : le masquage **IP/MAC** suit désormais un flag `network` dédié
  (gaté Supporter comme dans la fiche DPO), au lieu d'être couplé au flag `phone`.

## 2026-05-31 — 0.8.10 — Audit 4 agents : câblage pii_advanced + honnêteté docs

- **pii_advanced CÂBLÉ** : le masquage avancé (NIR/SIRET + regex custom) est désormais
  réellement appliqué dans le pipeline de triage quand licencié (était enregistré mais
  jamais consommé). Couvert par tests.
- **Docs honnêtes** : `dpo.md` / `README` / `SECURITY.md` reflètent le découpage masquage
  selon la licence (sans licence = email+phone ; avec licence Supporter = IBAN/secrets/IP-MAC/NIR-SIRET) +
  caveat « en clair » sans licence (transit ET journal `llm_calls`). NER retiré (non implémenté).
- multi-entités + exports planifiés marqués **« à venir »** dans la page Supporter (non câblés).
- NITs : alerte d'expiration en `warning`, `prefers-reduced-motion`, garde `--update`/
  `--bundle` (bootstrap), timeout santé mise à jour, code Supporter aligné en 0.8.10.

## 2026-05-31 — 0.8.9 — Masquage IBAN + secrets en Supporter

- Sans licence, seuls **e-mail et téléphone** sont masqués. **IBAN/cartes** et
  **secrets** (mots de passe, tokens, clés API) passent en feature **Supporter**
  (`FEATURE_PII_ADVANCED`) — toggles verrouillés + **bandeau d'avertissement** clair
  (« envoyés EN CLAIR au LLM »). Docs/Sécurité mises à jour pour refléter ce découpage.

## 2026-05-31 — 0.8.8 — Logo « nœud de décision » (login + sidebar)

- Logo unifié sur le favicon (page de connexion + en-tête sidebar) ; remplace le « M »
  montagne et l'icône bouclier du login.

## 2026-05-31 — 0.8.7 — Nouveau favicon

- Favicon « nœud de décision » (le LLM propose → le code décide), charte indigo.

## 2026-05-31 — 0.8.6 — Audit multi-agents : cohérences

- Code Supporter **réaligné** sur la version du cœur (était figé en 0.7.0).
- `.env.example` : `UPDATE_CHECK_TTL_SECONDS` documenté. Doc de MAJ clarifiée
  (`update.sh` = avec sauvegarde ; `install.sh --update` = rapide). **Conventions internes** ajoutées
  (conventions : bump version + CHANGELOG + release + docs à jour à chaque changement).
- `is_newer` : comparaison semver robuste aux longueurs inégales (1.0 vs 1.0.0).

## 2026-05-31 — 0.8.5 — Bouton de mise à jour guidé + édition dans la barre

- **Store** : carte « Mise à jour disponible » (notes de release + commande
  `./install.sh --update` + bouton Copier + lien releases). Action privilégiée laissée
  à l'hôte (aucun socket Docker exposé). `/api/version` remonte `latest_notes`.
- **Barre du haut** : badge d'édition (Community / Supporter) à gauche de l'indicateur
  de version/MAJ.

## 2026-05-31 — 0.8.3 — Vérification de mise à jour automatique

- Cache de vérification ramené de 6 h à **1 h** (configurable `UPDATE_CHECK_TTL_SECONDS`)
  + re-check auto de l'UI toutes les 30 min → une release publiée est détectée **sans
  redémarrage**.

## 2026-05-31 — 0.8.1 → 0.8.2 — Version checker + correctifs install

- **Version checker** (opt-in, souverain — `UPDATE_CHECK_URL` vide par défaut = zéro
  appel sortant) : endpoint `/api/version`, indicateur dans la barre du haut, widget
  flottant (lien GitHub + « Offrir un café »). Le flux gère objet (GitHub) **et** tableau
  (GitLab `/releases`) + redirections.
- **install.sh** : `--update` (git pull + rebuild) ; attente non bloquante (teste
  `/api/status`, fail-fast si crash) ; **mot de passe admin obligatoire** ; build via le
  builder classique (sans buildx) ; bootstrap `curl | sh`. `SESSION_HTTPS_ONLY=false` par
  défaut (pilote HTTP). Sidebar : « Moteur en marche » sans la version (0.8.2).

## 2026-05-31 — 0.8.0 — Open-core : édition Community + fonctions sous licence

Mise en place de l'open-core : un cœur gratuit + des fonctions débloquées par licence,
partageant la même base :

- **Renommage** du dépôt en **édition Community** (le cœur, MIT).
- **Système de licence** signé **Ed25519, vérifié 100 % hors-ligne** (zéro phone-home,
  compatible air-gap) : `domain/licensing.py` (vérif + catalogue de features),
  `services/license_service.py`, endpoint `/api/license`, garde `require_feature`.
  La clé **débloque** des features — elle ne télécharge rien.
- **Loader à plugins** (`plugins.py`, entry points `itsm_modern_ai.plugins`) : le core
  découvre les fournisseurs de features installés. Sans licence valide, les features
  sous licence restent verrouillées.
- **Page de licence** (UI) : édition active, saisie/réinitialisation de clé, catalogue des
  features (verrouillées vs débloquées).
- **Features sous licence** : masquage PII avancé (NIR/SIRET/regex custom), multi-entités
  avancé, exports planifiés/DPO+. Le masquage de base, les connecteurs GLPI (legacy + V2)
  et Postgres **restent gratuits**.
- Tests : **295 pytest · 64 vitest** (+ suite dédiée pour les features sous licence).

## 2026-05-30 — Audit multi-agents (6) : correctifs ops & frontend

Seconde passe d'audit complet (backend, sécurité, frontend, devops, docs, live). Backend,
sécurité et live confirmés sains. Correctifs des risques trouvés côté ops/frontend :

- **`update.sh` sûr en PostgreSQL** : détecte le moteur (profile `postgres` actif / `ITSM_DATABASE_URL`)
  et fait un **`pg_dump` avant migration** (avant : sauvegarde SQLite vide → migration Postgres
  **sans backup**). Copie SQLite WAL-safe (`itsm.db*`), conscience du profile au redémarrage,
  refus si modifs git locales, attente santé par ID conteneur (timeout configurable).
- **Image Docker PostgreSQL-ready** : `uv sync … --extra postgres` → `psycopg` embarqué, le
  profile `postgres` fonctionne sans rebuild dédié (avant : `ModuleNotFoundError`).
- **Frontend** : plus de **scope OAuth orphelin** envoyé en mode legacy après bascule V2→legacy
  (`GlpiConnection.save()` purge la clé hors V2) ; effet de bord sorti de l'updater `setScopes`.
  Test de régression ajouté.
- `install.sh` : attente santé robuste (par ID) + support non-interactif (`ITSM_ADMIN_PASSWORD`).
- Tests : **276 pytest · 63 vitest**.

## 2026-05-30 — Mise à jour on-premise sûre (`update.sh`)

- **`./update.sh`** : met à jour l'instance avec **sauvegarde préalable** de `./data` (base +
  master key, horodatée sous `backups/`), `git pull`, rebuild + redémarrage, attente santé, et
  **procédure de rollback** affichée en cas d'échec de migration. Les migrations Alembic
  s'appliquent automatiquement au boot ; les données sont préservées (jamais `down -v`).
  `--no-pull` pour ne pas tirer le code. Cibles `make update` / `make backup`.
- Doc « Mise à jour » dans `docs/install.md`, incluant la variante **registry** (image CI
  `:latest`/`:<sha>` → `docker compose pull && up -d`, épinglage/rollback par tag).
- `backups/` ajouté au `.gitignore`.

## 2026-05-30 — Installation en une commande + mot de passe admin sans clair

- **`./install.sh`** : build + démarrage + création du compte admin en une commande. Le mot
  de passe est saisi à l'écran (masqué) et stocké **uniquement en hash Argon2 chiffré** —
  plus besoin de `ADMIN_PASSWORD` en clair dans `.env`. `./install.sh --reset-password` pour
  le rotationner.
- **CLI `python -m itsm_modern_ai.admin_setup`** (`--force`, `--check`) : amorçage/rotation du
  mot de passe admin (prompt masqué, ou `ITSM_ADMIN_PASSWORD`/stdin en non-interactif).
  Cible `make set-admin-password`. Comble le manque de rotation (jusqu'ici uniquement via `.env`).
- `ADMIN_PASSWORD` (`.env`) rétrogradé en **fallback optionnel** (CI/non-interactif), commenté
  par défaut dans `.env.example` ; ignoré dès qu'un hash existe.
- Tests : **276 pytest · 62 vitest** (`tests/unit/test_admin_setup.py`).

## 2026-05-30 — Audit multi-agents : correctifs moteur + cohérence

Vérification complète du projet (5 agents : backend/archi, sécurité, frontend, docs, live).
Sécurité : aucun finding critique/élevé (durcissements intacts, secrets OK, endpoints auth OK).

- **Correctif (moteur)** : `confidence_threshold` (FR-8) et `cost_cap_eur_per_day` (FR-10)
  étaient réglables dans l'UI mais le moteur lisait la valeur `.env` figée → réglages
  **silencieusement ignorés**. Désormais résolus en config runtime (UI > `.env`) dans
  `build_triage_service` et utilisés par `TriageService`. Régression couverte
  (`test_runtime_confidence_threshold_is_honored`).
- **Cohérence doc** : `docs/glpi-api-v2.md` + `.env.example` documentent les deux URL de base
  distinctes (`GLPI_BASE_URL` legacy / `GLPI_V2_BASE_URL` v2) et `GLPI_OAUTH_SCOPE`.
- Tests : **272 pytest · 62 vitest** verts.

## 2026-05-30 — UX connexion GLPI + durcissement V2 (Beta)

- **Scopes OAuth** : le connecteur V2 demande désormais `api user` par défaut (configurable,
  `GLPI_OAUTH_SCOPE` / sélection multiple dans l'UI). `api` seul suffit au triage mais
  `/Administration/User/Me` (aperçu du compte) exige `user` — diagnostiqué en live (403
  `ERROR_RIGHT_MISSING`). Token OAuth envoyé en **form-urlencoded** (standard, vérifié live).
- **Deux URL de base distinctes** : `glpi_base_url` (legacy apirest.php) et `glpi_v2_base_url`
  (api.php/v2.3) coexistent — plus de champ partagé ambigu. Le lien web du Journal suit le
  mode actif (`active_glpi_base_url`).
- **Réinitialisation** : `POST /api/glpi/reset` + bouton UI « Réinitialiser » effacent toute
  la connexion GLPI (URLs, tokens, identifiants OAuth) d'un coup.
- **UI** : page Connexion GLPI cohérente legacy/V2 — sélecteur d'API, URL dédiée par mode,
  scopes en cases à cocher, aperçu « compte du bot » (avatar/photo), message de test inline.
- **Correctif tz (V2)** : l'API V2 renvoie des dates timezone-aware → normalisées en naïf UTC
  dans le mapper (sinon `get_recent_tickets` levait `offset-naive vs offset-aware` sur le
  Dashboard). Trouvé en vérification live.
- **Parité legacy↔V2 complétée** (audit fonction par fonction) :
  - `server_version` (V2) via `GET Setup/Config/core/version` (scope `api`) → la version GLPI
    (ex. 11.0.7) s'affiche dans la topbar **aussi en V2** (avant : « GLPI connecté » seul).
  - `technician_profiles` (V2) renseigné depuis le `default_profile` de chaque User (le legacy
    joint tous les profils ; la V2 expose le profil par défaut → approximation).
- **Indicateur d'API** en pied de sidebar (au-dessus de « Moteur en marche ») : « API GLPI :
  V2 (OAuth2) » ou « apirest » selon le mode configuré.
- **Validé en live** contre une instance GLPI 11.0.7 réelle : OAuth (api+user), `whoami`,
  `server_version` (11.0.7), référentiels (cat:8/tech:63/grp:2/ent:1 + 15 profils), tickets
  « New », tickets récents. Écritures (suivi, assignation) couvertes par tests/contrat, non
  exécutées en live (mutation de tickets réels).
- Tests : **271 pytest · 62 vitest**.

## 2026-05-30 — Moyen terme : PostgreSQL + connecteur GLPI API V2 (**Beta**)

> ⚠️ **Beta — encore tout jeune.** Les deux fonctionnalités sont **opt-in** ; les défauts
> (SQLite + GLPI legacy `apirest.php`) sont **inchangés**. À éprouver avant la prod.

### PostgreSQL (Beta) — `docs/postgresql.md`
- Driver `psycopg` 3 en **extra optionnel** (`uv sync --extra postgres`).
- `db.init_engine` : pooling (`pool_pre_ping` + `pool_size`/`max_overflow`) pour toute base
  réseau ; SQLite inchangé. Nouveaux réglages `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` /
  `DB_POOL_PRE_PING`.
- `docker-compose.yml` : service `postgres` **optionnel** (profile `postgres`, non lancé par
  défaut) ; `DATABASE_URL` du conteneur surchargeable via `ITSM_DATABASE_URL`.
- **Vérifié** : les 8 migrations Alembic + un aller-retour ORM (tz-aware) tournent sur un
  PostgreSQL 16 réel.

### Connecteur GLPI API V2 (Beta) — `docs/glpi-api-v2.md`
- Nouveau `adapters/itsm/glpi/v2/` (client OAuth2 password grant + Bearer + anti-SSRF,
  connector `ItsmPort`, mapper objets imbriqués `{id,name}` + `team`).
- API haut-niveau GLPI 11 : `/Assistance/Ticket` (PATCH), `Timeline/Followup`, `TeamMember`
  (assignation), `Dropdowns/ITILCategory`, `Administration/User|Group|Entity`, recherche RSQL.
- Bascule `GLPI_API_VERSION=legacy|v2` ; identifiants OAuth (`GLPI_OAUTH_CLIENT_ID/USERNAME`
  non-secrets, `client_secret`/`password` chiffrés via l'UI). Contrat ancré sur le spec
  OpenAPI réel d'une instance GLPI 11.0.7 (`/api.php/v2.3/doc.json`).
- Couvert par `tests/integration/test_glpi_v2_connector.py`. Tests : **259 pytest** verts.

## 2026-05-30 — Correctif : lien GLPI versionné (`api.php/v1`) pointait sur l'API

- **Bug** : avec une URL API GLPI **versionnée** (`https://host/api.php/v1`), le lien du
  ticket visait `…/api.php/v1/front/ticket.form.php?id=…` → l'API GLPI répondait
  `ERROR_APP_TOKEN_PARAMETERS_MISSING` au lieu d'ouvrir le ticket dans l'UI web. Cause :
  `ticket_web_link` ne retirait que le **suffixe** `/apirest.php` ou `/api.php` en fin de
  chaîne, donc `/api.php/v1` n'était pas reconnu.
- **Correctif** (`services/links.py`) : on **tronque à partir** du marqueur (`/apirest.php`
  ou `/api.php`), quel que soit ce qui suit (`/v1`, `/v1/`, …) → racine web correcte
  `https://host/front/ticket.form.php?id=<id>`. Le lien étant reconstruit à la lecture,
  les décisions déjà journalisées sont corrigées sans migration. Couvert par
  `tests/unit/test_links.py::test_strips_versioned_api_php`. Tests : **246 pytest** verts.

## 2026-05-30 — Correctif : lien GLPI du Journal cliquable en production

- **Bug** : dans le *Journal des décisions*, le **Sujet** n'était cliquable (lien vers le
  Ticket GLPI) qu'en mode `/demo`, pas en production. Cause : le lien était figé à
  l'enregistrement à partir de `Settings.glpi_base_url` (valeur **`.env`**, vide en prod
  où GLPI se configure via l'UI → table `RuntimeConfig`). `glpi_link` était donc stocké
  à `""` et le frontend rendait le sujet en texte brut.
- **Correctif lecture** (`api/routes/decisions.py`) : le lien front est désormais
  **reconstruit à la lecture** depuis l'URL GLPI **runtime** (config UI), avec repli sur
  le lien stocké. Répare aussi les décisions **déjà enregistrées** avec un lien vide et
  reste valide si l'URL GLPI change.
- **Correctif écriture** (`api/runtime.py` + `services/triage.py`) : `build_triage_service`
  résout `glpi_base_url` via la config runtime (UI > `.env`) et l'injecte dans
  `TriageService` → les nouvelles décisions (et l'export CSV) portent le bon lien.
- Régression couverte par `tests/integration/test_audit_auth_api.py`
  (`test_journal_link_rebuilt_from_runtime_glpi_url`). Tests : **245 pytest** (verts),
  ruff propre. Aucun changement frontend (le rendu `<a href>` était déjà correct).

## 2026-05-29 — Vague « audit-2026-05 » : durcissement sécurité, observabilité, build

Audit multi-agents (ancrage **OWASP LLM Top 10 2025**, **AI Agent Security Cheat Sheet**,
revue *production readiness*) suivi de quatre lots de correctifs. Synthèse complète,
tableau des vulnérabilités et **risques résiduels** dans [`docs/audit-2026-05.md`](docs/audit-2026-05.md).
Aucun changement de fonctionnalité métier visible. Tests : **244 pytest** (verts), ruff propre.

### Sécurité

- **Path traversal SPA confiné** (`api/spa.py`) : tout chemin statique est résolu et
  doit rester **sous `dist/`** (`is_relative_to`). Bloque `..%2f..%2f` → lecture de
  `master.key` / `itsm.db` / `.env`. Couvert par `tests/integration/test_spa_security.py`.
- **Séparation des clés de chiffrement et de signature de session (HKDF-SHA256)** :
  la clé Fernet ne sert plus *aussi* de secret de session. `FernetSecretsBox.derive_key(info=…)`
  dérive une sous-clé dédiée (`encrypted.py`), et `app.py` l'emploie pour la session
  (`info=b"session-signing"`). Secret **distinct** et **stable** entre redémarrages.
- **Authentification fail-closed** (`api/security.py`) : sans mot de passe admin
  configuré, l'admin est désormais **refusé (401)** par défaut. L'ancien comportement
  « ouvert » (réseau interne) doit être activé explicitement via le nouveau réglage
  `dev_open_admin` (dev/labo). Couvert par `tests/integration/test_audit_auth_api.py`.
- **Anti-SSRF lexical** (`domain/url_safety.py` + validateurs `api/routes/config.py`) :
  les URLs de base poussées via l'API (GLPI, LLM) exigent `https://` + un hôte routable ;
  loopback/IP privée/metadata cloud rejetés à l'écriture (Ollama : `http`+local toléré).
- **Anti-SSRF runtime / anti DNS-rebinding** (`url_safety.assert_resolved_ip_is_public`
  + hooks httpx `adapters/llm/_http.py`) : avant chaque appel sortant, l'hôte est **résolu**
  et toute IP interne est **bloquée** (fail-closed sur échec DNS) — *avant* l'envoi du
  token. Activé par `ssrf_guard_enabled` (défaut `true`). `tests/unit/test_url_safety.py`.
- **Re-masquage des brouillons en modes auto** (`services/triage.py`) : avant toute
  publication **publique** (semi_auto/full_auto), le brouillon LLM est **re-masqué** et
  borné en longueur (`PUBLIC_DRAFT_MAX_CHARS`). Le mode suggestion (privé) est inchangé.
- **Masquage PII étendu** (`domain/masking.py`) : ajout cartes bancaires (validation
  **Luhn**), **IPv4**, **MAC**, téléphone **E.164 international**, clés cloud (AWS `AKIA…`,
  Google `AIza…`) → `[CARD]`/`[IP]`/`[MAC]`/`[PHONE]`/`[CLOUD_KEY]`. `tests/unit/test_masking.py`.
- **Neutralisation de l'injection de formule CSV** (`persistence/journal.py`) : les
  cellules d'export commençant par `= + - @ \t \r` sont préfixées d'une apostrophe.
  `tests/unit/test_cost_cap_journal.py`.
- **Décryptage fail-safe** : un secret illisible (MASTER_KEY incohérente) lève une
  `SecretDecryptError` métier (`domain/errors.py`) au lieu d'un 500 qui verrouillait
  l'admin ; le bootstrap auth la traite comme « non amorcé » (fail-closed propre).
- **Cookie de session `Secure`** pilotable via `session_https_only` (défaut `true`).

### Observabilité

- **Logging structuré** (`config/logging.py`) : `log_level` + `log_format` (`text`|`json`),
  init centralisée au démarrage. Le format JSON n'inclut **aucune PII**. `tests/unit/test_logging_config.py`.
- **Endpoint Prometheus `GET /metrics`** (`api/metrics.py`, hors `/api`) : compteur de
  requêtes + histogramme de latence, label `path` = **route templatée** (cardinalité
  bornée, pas de PII). Désactivable (`metrics_enabled`) et **protégeable** par
  `metrics_token` (Bearer / `X-Metrics-Token`, comparaison à temps constant).
  `tests/integration/test_metrics_endpoint.py`.

### Build & CI

- **Build reproductible** : `uv.lock` figé, `Dockerfile` installe depuis le lock,
  Python aligné **3.13** partout (pyproject `requires-python >=3.13`, image, CI).
- **CI** : nouveau job `package:image` (build/push image) dans `.gitlab-ci.yml`.
- **Durcissement `docker-compose.yml`**.

### Qualité

- **Sandbox lit le périmètre EFFECTIF en base** (`api/routes/sandbox.py`) et non le
  cache mémoire (vide si polling off). Garde-fou de non-régression ajouté :
  `tests/integration/test_sandbox_api.py::test_sandbox_uses_db_scope_even_without_cache`.
- **Borne de génération LLM** (`max_tokens`, défaut 1024) sur l'adaptateur
  OpenAI-compatible (aligné sur Anthropic) — plafonne coût/latence (LLM10).
- **Test d'architecture des ports** : `tests/unit/test_architecture.py::test_ports_depend_only_on_domain`
  vérifie que `ports/` ne dépend que de `domain` (+ stdlib/typing/pydantic).
- **Versions unifiées 0.7.0**.

### Documentation

- Nouveau document de synthèse d'audit [`docs/audit-2026-05.md`](docs/audit-2026-05.md).
- `SECURITY.md`, `docs/llm-providers.md`, `docs/dpo.md`, `docs/install.md`, `docs/api.md`,
  `README.md`, `docs/project-context.md` mis à jour (nouveaux réglages, `/metrics`,
  logging, masquage étendu, Python 3.13, compteur de tests **244**).

## 2026-05-29 — Docs : sortie du planning interne du repo public

Sortie des artefacts internes du repo public vers un dossier `notes/`
(gitignored) : `HANDOFF.md` (notes de passation), `bootstrap-archive.md`
(archive d'amorçage) et tout `docs/planning/` (PRD, architecture
détaillée, epics, addendum). Le repo public garde le README pro,
`docs/install.md`, `docs/dpo.md`, `docs/spike.md`, `docs/project-context.md`
(invariants), `docs/design/` et les conventions racine (LICENSE,
SECURITY, CHANGELOG). Refs README et `project-context.md` mises à jour.

## [Non publié] — 2026-05-29

Toilettage code/archi de fond (5 phases — aucun changement de fonctionnalité visible).
Tests : **177 → 180 pytest**, vitest **58/58**, E2E Playwright **2 → 3 parcours**.

### Sécurité

- **Trust proxy headers** pour le rate-limit login (anti brute-force). Nouveau helper
  `api/client_ip.py` qui lit `X-Forwarded-For` derrière un reverse proxy fiable. Activé
  par le réglage `trust_proxy_headers: bool = False` (défaut sûr) et propagé à uvicorn
  via `entrypoint.sh` lorsque `TRUST_PROXY_HEADERS=true`. Sans ce correctif, toutes les
  requêtes paraissaient venir de l'IP du proxy → rate-limit contournable. Couvert par
  `tests/unit/test_client_ip.py` (5 cas).
- `auth.py` et `automations.py` utilisent désormais ce helper plutôt que
  `request.client.host` brut.
- `docs/install.md` + `.env.example` documentent la configuration reverse proxy.

### Persistance

- `ProcessedTicket.processed_at` passe en `UtcDateTime` indexée (cohérent avec le Lot C
  MR !19 qui avait traité `DecisionLog.ts` et `LlmCall.ts`). Migration Alembic
  `d2f8a9c5_processed_tickets_ts_aware`. Évite un `TypeError` au futur portage Postgres
  lors des comparaisons `cutoff < processed_at`. Test ajouté dans `test_tz_aware_ts.py`.

### Frontend (i18n)

7 chaînes UI hardcodées sont désormais passées par `useT()` :
`LangToggle` (aria-label, title), `ThemeToggle` (label, libellé bouton), `Layout`
(`title="Administrateur"`), `ui/toast.tsx` (`aria-label="Fermer"`),
`AiProvider` (`Field label="Base URL"`), `Debug` (`title="Diagnostics"`),
`Automations` (`title="Automations"`).

### Tests ajoutés

- **Routage groupe** (bout-en-bout) : `test_group_routing_writes_followup_and_applies_in_full_auto`
  et `test_group_routing_accepted_in_suggestion_mode`. Vérifie que `apply_decision` est
  invoqué avec `group_id` (et `technician_id=None`) en `full_auto`, et qu'aucune mutation
  n'a lieu en `suggestion`.
- **Cost cap chaîné** : `test_cost_cap_blocks_subsequent_tickets_same_day`. Vérifie
  qu'un 2ᵉ ticket dans le même cycle est aussi blocké après dépassement du cap.
- **E2E Playwright** : nouveau parcours `frontend/e2e/sandbox.spec.ts` (login →
  bac à sable → décision simulée avec résolution de nom de catégorie + technicien).

### Cosmétique

- Constante `DEFAULT_DECISIONS_LIMIT = 500` extraite dans `persistence/journal.py`,
  réutilisée par `api/routes/decisions.py` (au lieu du nombre magique dupliqué).
- `datetime.now(UTC)` → `_utcnow()` dans `persistence/journal.py:daily_series`
  (cohérent avec le reste du module).
- Commentaire de robustesse au-dessus de `SYSTEM_PROMPT` dans `domain/prompting.py` :
  explique que `category: int | None` accepte null (au cas où le LLM ignore le prompt),
  et que la whitelist rejette alors en « à trier ».

### Documentation

- README et HANDOFF : compteurs de tests à jour (**177 pytest**, **58 vitest**, **2
  parcours E2E**), liste complète des endpoints (ajoute `operational-metrics`,
  `automations/retention*`, `debug/*`), pistes ouvertes § 8 nettoyées (version GLPI
  topbar marquée ✅ fait, durcissement prod partiel précisé).
- Plan de développement annoté COMPLET.
- Réorganisation des docs : `docs/design/` regroupe les specs design ; le doc
  d'amorçage initial est renommé `docs/bootstrap-archive.md` pour le distinguer
  du `HANDOFF.md` actif.

## 2026-05-28 — Lot C + Lot 4 (MR !19)

- **Audit cybersécu Lot C** : `DateTime(timezone=True)` sur `DecisionLog.ts` et
  `LlmCall.ts` via le nouveau `UtcDateTime` TypeDecorator
  (`persistence/tables.py`). Migration `c1a7e4b2_ts_timezone_aware`. Préparation
  au portage Postgres (sans ça, `cutoff < ts` casse avec `TypeError`).
- **Factorisation httpx LLM (Lot 4)** : nouveau `adapters/llm/_http.py` exposant
  `arequest()` (avec capture du body 4xx pour diagnostic) et `healthcheck_get()`.
  Utilisé par `openai_compatible.py` et `anthropic.py`.
- Tests : `tests/unit/test_tz_aware_ts.py` (5 cas) et `tests/unit/test_llm_http_helper.py`
  (8 cas).

## 2026-05-27 — UI sandbox, modes, toasts, i18n complet, écarts post-pilote

- **Toasts** UI : nouveau `components/ui/toast.tsx` + `ToastProvider` global ; toutes les
  pages avec « Enregistrer » donnent un feedback succès/erreur.
- **Bac à sable** : résolution des noms (catégorie, technicien, groupe) côté API
  (`api/routes/sandbox.py`) + affichage coloré (Tags) côté UI (`pages/Sandbox.tsx`).
  Persistance du filtre « éligibles seulement » dans `RefEligibilityEditor`
  (localStorage par kind).
- **Adaptateur Anthropic** : suppression du préfill assistant (refusé par Sonnet 4.6+),
  extracteur tolérant de JSON, capture body 4xx, `Decision.category` désormais `int | None`.
- **Périmètre** (`Scope.tsx`) : boutons « tout sélectionner » pour Entités et Catégories.
- **Documentation** : `priorityLabel`, `priorityTone`, `confidenceTone` dans
  `frontend/src/lib/labels.ts`.

## Phases initiales — Epics 1 → 5 (résumé)

- **Epic 1 — Spike** (`scripts/spike_routing.py` + `tests/fixtures/tickets_fr.json`) :
  validation du routage par fiches en prose + précision LLM sur tickets FR.
- **Epic 2 — Fondations & connexion GLPI** : connecteur legacy `apirest.php`,
  polling idempotent (APScheduler), suivi privé `ITILFollowup`.
- **Epic 3 — Moteur à garde-fous** : pipeline immuable masquage → LLM → Pydantic →
  whitelist → seuil → suivi/à trier ; mode suggestion ; cost cap.
- **Epic 4 — Audit & packaging** : journal annotable, export CSV DPO, auth Argon2,
  secrets Fernet, conteneur non-root, healthcheck.
- **Epic 5 — Console web** (post-GO) : SPA React 19 + Vite + Tailwind v4, 4 fournisseurs
  LLM, scan GLPI + sélection de périmètre (catégories, entités, techniciens, groupes)
  avec fiches en base, modes d'exécution par entité (`suggestion`, `semi_auto`,
  `full_auto`), masquage PII configurable.
