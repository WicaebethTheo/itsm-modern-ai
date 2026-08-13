# Fiche DPO — ITSM Modern AI (pilote V1)

> Document destiné à la DPO / au RSSI pour valider le flux de données en une réunion (FR-21, PRD §10).
> Objectif : décrire **honnêtement** le traitement, sans sur-promettre.

## Promesse exacte

**Coordonnées masquées avant l'appel LLM — la portée DÉPEND DE LA LICENCE.** Ce **n'est pas**
une « anonymisation ». Lisez attentivement le périmètre ci-dessous.

## Portée du masquage (à lire attentivement)

Le masquage (FR-14) repose sur des **expressions régulières** (heuristiques). Le code est
livré dans l'image unique ; sa portée **diffère selon la licence** (open-core) :

**Sans licence (édition Community, gratuite)** — masque uniquement :
- adresses **email** → `[EMAIL]` ;
- numéros de **téléphone** (FR et international E.164) → `[PHONE]`.

> ⚠️ **Sans licence, les IBAN, cartes bancaires, IP/MAC, mots de passe / tokens / clés API
> NE sont PAS masqués** : ils sont transmis **EN CLAIR** au LLM **et** conservés en clair dans
> le journal des appels (table `llm_calls`). **À porter explicitement à la connaissance de la
> DPO** avant toute mise en production avec des données réelles.

**Avec une licence Supporter** — déverrouille en place le masquage de :
- **IBAN** → `[IBAN]`, **cartes bancaires** (validation Luhn) → `[CARD]` ;
- **adresses IP** (IPv4) / **MAC** → `[IP]` / `[MAC]` ;
- **mots de passe / tokens** et **clés cloud** (AWS `AKIA…`, Google `AIza…`) → `[SECRET]` / `[CLOUD_KEY]` ;
- identifiants FR **NIR / SIRET** → `[NIR]` / `[SIRET]`.

> Les **patterns regex personnalisés** sont une capacité **non encore exposée à la
> configuration** : la console les affiche « à venir » et ils **ne masquent rien** pour l'instant.
> À ne PAS présenter comme actifs à la DPO tant que leur configuration n'est pas livrée.

> ⚠️ **L'expiration d'une licence rouvre le flux en clair, sans intervention humaine.**
> Le masquage avancé est conditionné à une licence *valide* : le jour où elle expire, le
> cycle de polling suivant reconstruit le moteur avec IBAN, cartes, secrets, IP/MAC et
> NIR/SIREN/SIRET **désactivés**, et ces données repartent en clair au fournisseur LLM — où
> elles s'accumulent aussi en clair dans la table `llm_calls`. Le seul signal automatique
> est un `WARNING` dans les journaux du conteneur ; la console prévient l'**administrateur**
> à J-30, mais rien ne prévient la DPO, et rien ne suspend le traitement.
>
> C'est une **régression de conformité déclenchée par une échéance de facturation**, non par
> une décision technique. Deux conséquences à porter au registre : inscrire la date
> d'échéance comme une échéance de conformité, et décider à l'avance si le polling doit être
> suspendu (`polling_enabled`) plutôt que de laisser le traitement continuer dégradé.

> En modes `semi_auto`/`full_auto`, le **brouillon généré par le LLM est re-masqué** (selon
> la licence) avant toute publication publique au demandeur.

Dans **tous** les cas, le masquage **NE masque PAS** les **noms de personnes** ni les
**adresses postales** (reconnaissance d'entités nommées non implémentée). Des données
nominatives peuvent donc apparaître en clair dans le contenu transmis au LLM. La promesse est
« coordonnées masquées selon la licence », **pas** « aucune donnée nominative ».

## Résidence des données

- Fournisseur LLM par défaut : **Mistral EU**, sous **DPA**, **pas de Cloud Act**. Aucun transfert hors UE par défaut.
- Quatre fournisseurs sont sélectionnables depuis l'interface :
  - **Mistral EU** — souverain (UE), défaut recommandé.
  - ⚠️ **OpenAI** — **hors UE / non-souverain**.
  - ⚠️ **Anthropic (Claude)** — **hors UE / non-souverain**.
  - **Ollama** — modèle **100 % local** sur l'infra du client : **aucune donnée ne sort** (pas de clé API, pas de transfert).
- ⚠️ **OpenAI et Anthropic sont hors UE** : s'ils sont activés, le contenu masqué des tickets est transmis hors UE. À **valider explicitement** avec la DPO avant activation ; le défaut souverain reste Mistral EU.
- Toute l'application tourne **on-premise** sur l'infrastructure du client.
- **Sorties réseau de l'instance — liste exhaustive** :
  1. le **fournisseur LLM configuré** (contenu masqué du ticket — cf. « Portée du masquage ») ;
  2. le **GLPI** du client (réseau interne) ;
  3. la **vérification de version**, **activée par défaut** (opt-**out**, et non opt-in).
- **Détail de la vérification de version** (à consigner tel quel au registre) :
  - **URL appelée** : `https://api.github.com/repos/WicaebethTheo/itsm-modern-ai/releases/latest` (paramètre `UPDATE_CHECK_URL`) ;
  - **Déclencheur** : uniquement le chargement de la console par un **administrateur authentifié** (`GET /api/version`) — pas de tâche de fond, pas d'appel si personne ne se connecte ;
  - **Fréquence** : au plus **une requête par heure** (cache, `update_check_ttl_seconds`, défaut 3 600 s) ;
  - **Données transmises par l'instance** : **aucune**. Requête `GET` sans corps, sans identifiant d'instance, sans compteur d'usage, sans donnée de ticket. Le fournisseur de la plateforme d'hébergement du dépôt voit ce que voit n'importe quel visiteur d'une page publique (adresse IP publique de sortie, en-têtes HTTP standard) ;
  - **Données reçues** : le dernier numéro de version publié et les notes de release ;
  - **Désactivation** : `UPDATE_CHECK_URL=` (valeur vide) dans `.env` → **aucun appel**, déploiement **air-gap 100 % hors-ligne**. Le produit reste pleinement fonctionnel.
- **Licence Supporter** : vérifiée **100 % hors-ligne** (signature Ed25519, clé publique embarquée). **Aucun serveur de licence, aucun appel sortant** — y compris en air-gap. La vérification est hors-ligne ; l'**expiration**, elle, a des effets sur le masquage (voir l'avertissement plus haut).
- **Périmètre d'action restreint par l'admin** : l'IA n'utilise que les **catégories, techniciens, groupes et entités explicitement sélectionnés** par l'admin (Whitelist curée depuis un scan GLPI). Tout objet hors de ce périmètre est ignoré (Ticket « à trier »).

## Minimisation

Le masquage intervient **avant** tout appel LLM (ordre du pipeline immuable), à destination du seul fournisseur LLM configuré.

> ⚠️ **Le contenu du ticket n'est pas la seule chose transmise.** Le prompt envoyé au LLM
> contient aussi, à **chaque** appel, le **périmètre autorisé** : les **noms** des
> techniciens et des groupes éligibles (`id: nom`), et leurs **fiches en prose libre**
> rédigées par l'admin (compétences, disponibilités, consignes de routage). Ces éléments
> **ne sont pas masqués** — ils sont la matière même du routage : sans eux, le LLM ne peut
> pas proposer d'affectation.
>
> Ce sont des **données personnelles de salariés**, à déclarer au registre au même titre
> que le contenu des tickets. Si le fournisseur configuré est OpenAI ou Anthropic, elles
> **sortent de l'UE** comme le reste du prompt. Deux conséquences pratiques :
> - les techniciens concernés doivent être **informés** de ce traitement ;
> - les fiches ne devraient contenir **aucune donnée personnelle superflue** (pas de
>   téléphone personnel, pas de motif d'absence, pas d'information de santé). Une fiche
>   utile au routage tient en compétences et périmètre.
>
> **Limite de traçabilité à connaître** : le journal `llm_calls` n'enregistre que le
> **contenu du ticket** masqué, pas ces blocs ni le prompt système. Le prompt réellement
> transmis n'est donc pas reconstituable a posteriori à partir du seul journal.

## Console DPO (page dédiée)

La console expose une page **« Confidentialité (DPO) »** (`/privacy`, sous l'auth locale) qui
permet de vérifier en réunion, **sans lire le code**, ce qui est réellement masqué :

- **Tableau des catégories PII** dont la colonne dit ce qui SORT, pas ce qui se vend :
  elle s'intitule **« Envoyé au LLM »** et vaut *Masqué*, *Envoyé en clair*, ou
  *Non implémenté*. Sans licence, IBAN/cartes, secrets/tokens/clés API, IP/MAC et
  NIR/SIRET sont donc affichés *Envoyé en clair*, le badge Supporter venant **en
  complément** de cette mention, jamais à sa place. Le statut est lu depuis le moteur, pas
  codé en dur — il reflète la licence active. Une catégorie Community simplement décochée
  par l'admin tombe elle aussi en *Envoyé en clair* : c'est le cas que l'ancien libellé
  « Inactif » rendait invisible alors qu'il est le plus grave.
- **Réglage du masquage, sur cette page.** Les quatre bascules (e-mails, téléphones, IBAN,
  secrets) vivaient dans l'écran « Moteur » : cette page **expliquait** à la DPO ce qui sort
  en clair sans pouvoir y changer quoi que ce soit, et le seul écran capable d'éteindre un
  motif portait le nom le moins susceptible d'attirer une DPO. Le tableau ci-dessus dit ce
  qui sort ; la carte juste en dessous en décide, et il est relu après chaque
  enregistrement. Le compteur « N/4 » porte sur ce qui est **enregistré**, jamais sur une
  saisie en cours. Sans licence Supporter, IBAN et secrets ne sont pas cochables : les
  activer ne masquerait rien, et le compteur ne le prétend pas.
- **Avertissement honnête** affiché sans licence : les catégories verrouillées transitent et
  sont journalisées **en clair** (à valider explicitement avant toute donnée réelle).
- **État réel de la purge** : les durées de rétention ne sont jamais affichées seules. Si la
  purge automatique est désactivée, la page le dit en toutes lettres — lire « 30 j » et en
  conclure que les données sont purgées était le seul contresens possible de cette page.
- **Outil « Tester le masquage »** : colle un texte d'exemple, l'API applique le masquage
  **réel** (état + licence courants) et renvoie le texte masqué **avec le décompte des
  remplacements par catégorie**, plus la liste nommée de ce qui n'a PAS été masqué — pour
  qu'on n'ait pas à comparer deux blocs à l'œil pour voir que l'IBAN est resté en clair.
- **Rappel des durées de rétention** et **lien vers le journal `llm_calls`**.
- **Export d'un rapport DPO** (`GET /api/privacy/report.md`) : un Markdown daté listant
  l'édition, les catégories masquées et les fenêtres de rétention — pièce jointe pour le dossier.
  Le statut d'une catégorie y **nomme la bonne cause** : *VERROUILLÉ (Supporter)* désigne
  uniquement un défaut de licence, et un motif désactivé par l'administrateur sous licence
  valide s'écrit *Désactivé (choix de l'administrateur) — transmis EN CLAIR*. Le rapport
  imputait auparavant les deux cas à la licence, et l'avertissement d'édition Community qui
  aurait pu rattraper la mention ne s'affiche, lui, qu'en l'absence de licence.

> Une page **« Coûts & quotas »** (`/cost`) complète l'observabilité : dépense LLM des
> dernières 24 h vs plafond journalier, nombre d'appels et tarifs configurés.

## Traçabilité

- **Log des appels LLM** (FR-19) : ticket, horodatage, modèle, contenu envoyé et reçu, coût. Le contenu loggé **reflète exactement le masquage réellement appliqué à l'envoi** — c'est-à-dire, sans licence Supporter, avec l'IBAN, les secrets et les IP **en clair**, puisque c'est ce qui est parti. Une preuve d'audit doit établir ce qui s'est passé, pas ce qu'on aurait souhaité.
  ⚠️ **Portée du journal** : seul le **contenu du ticket** y figure. Le prompt réellement transmis contient en plus le périmètre autorisé (noms des techniciens, fiches en prose) et le prompt système — cf. l'encadré de la section « Minimisation ». Le prompt complet n'est donc **pas reconstituable** à partir du journal.
- **Décisions automatisées (art. 22)** : l'export du Journal porte les colonnes **`mode`** et **`applied`**, qui distinguent une **suggestion** (le technicien garde la main) d'une **décision appliquée automatiquement** aux champs GLPI, avec réponse **publique** au demandeur en `full_auto`. C'est cette distinction qui détermine si le traitement relève de l'article 22 — le mode livré par défaut est `suggestion`, qui n'en relève pas.
- **Journal de décision** (FR-20) : ticket, décision, catégorie, confiance, horodatage, lien GLPI, **titre du ticket**.
- **Titre du ticket conservé en clair** : le Journal de décision stocke le **titre brut du ticket GLPI** (`subject`), **non masqué**, et l'affiche dans la console (page **Journaux**, sous authentification, carte « Journal des décisions ») — il sert à relire une décision sans rouvrir GLPI. Si un titre de ticket contient une donnée personnelle, elle est donc conservée en clair dans la base locale pour la durée de rétention du Journal (`retention_decisions_days`, défaut 365 j). Ce champ est **exclu de l'export CSV DPO** (`GET /api/export/decisions.csv` n'a pas de colonne `subject`). Le masquage PII s'applique au **contenu envoyé au LLM**, pas à ce champ d'audit local.
- **Export CSV** (FR-21) pour l'audit :
  - `GET /api/export/decisions.csv` — journal de décision ;
  - `GET /api/export/llm-calls.csv` — logs des appels LLM.

## Sécurité

- **Secrets chiffrés au repos** via Fernet (FR-25) — aucun secret en clair en base, dans `.env` ou dans les logs.
- **Authentification locale** requise pour les fonctions d'administration et d'export (FR-24).
- **HTTPS** via reverse proxy (FR-26).

## Anti-mouchard

Par conception (PRD §9.4) :

- **aucune métrique nominative** de performance par technicien ;
- **aucun enregistrement d'un rejet humain** (FR-18, FR-21) — ignorer une suggestion n'est ni tracé ni reproché.

## Rétention

Une **purge RGPD automatique** est implémentée (`services/retention.py`). Elle supprime définitivement, en base locale, les lignes plus anciennes que des fenêtres de conservation **configurables** :

- **Journal de décision** : `retention_decisions_days` (défaut **365 jours**) ;
- **Appels LLM** (masqués) : `retention_llm_calls_days` (défaut **90 jours**) ;
- **Absences TERMINÉES** (`technician_absences`) : même fenêtre que le Journal.

Une fenêtre **`<= 0` désactive** la purge de la table concernée (défaut sûr : on ne supprime jamais sans réglage explicite).

> ⚠️ **La purge ne couvre PAS tout — à consigner au registre.** Trois tables persistent
> hors de ces fenêtres :
>
> | Table | Contenu | Pourquoi elle n'est pas purgée |
> |---|---|---|
> | `processed_tickets` | identifiant GLPI de chaque ticket traité + horodatage | c'est le **registre d'idempotence** : le purger ferait re-trier (et re-facturer) d'anciens tickets. Aucun contenu, mais un identifiant et une date. |
> | `referential_cache` | **noms** des techniciens/groupes, profils GLPI, **fiches en prose** | c'est le périmètre autorisé, rafraîchi par scan GLPI ; le purger désarmerait le moteur. Ces fiches méritent une **revue périodique** par l'admin. |
> | `audit_log` | actions d'administration, avec l'**IP** de l'auteur | donnée d'**imputabilité** (art. 5.1.f / 32) ⚠️ **écrite mais lue par aucune route, aucun écran, aucun export** : la seule consultation possible est un `psql` direct. À régler AVANT de s'engager sur une exigence d'auditabilité, pas au moment de l'audit. La purger sur la fenêtre « tickets » offrirait un effacement de traces trivial : régler la rétention à 0 est justement une action auditée. |
>
> **Absences (`technician_absences`) — donnée personnelle, purgée.** « Qui est en congé,
> quand » est une donnée personnelle. Elle est conservée **tant que l'absence est en cours
> ou à venir** (c'est de la configuration active : elle pilote le routage), puis purgée avec
> le Journal une fois **terminée** — le produit n'a aucune raison de constituer l'historique
> des vacances de chacun. Ce n'est pas une métrique par technicien : on enregistre une
> **disponibilité déclarée par l'admin** pour router, jamais une mesure d'activité, de
> performance ou de présence effective (anti-mouchard, FR-18/21). Un remplaçant désigné est
> nommé dans le **prompt de routage** (« assure l'intérim de X jusqu'au … »), donc transmis
> au fournisseur LLM : à signaler au registre si les noms de techniciens ne l'étaient pas déjà
> — ils le sont, la liste des acteurs éligibles étant déjà dans le prompt.
>
> `audit_log` porte une IP, donc une donnée personnelle : une fenêtre de conservation
> dédiée (12 mois est l'usage courant) devra être décidée **explicitement**, et jamais
> recollée sur celle des tickets.
>
> **Le titre du ticket** (`subject`) est par ailleurs conservé en clair dans le Journal de
> décision — cf. section Traçabilité. Il suit, lui, la fenêtre `retention_decisions_days`.

**Job planifié.** Lorsque `automation_purge_enabled` est actif (défaut `true`), un job quotidien s'exécute à `automation_purge_hour_utc` (défaut **03:00 UTC**), planifié par le scheduler de l'application. Les durées et l'heure se règlent sur un **seul** écran, **Configuration › Automations**, carte « Purge des logs » : *Purge automatique activée*, *Rétention Journal (jours)*, *Rétention appels LLM (jours)* et *Heure d'exécution (UTC)*. La modification est prise à chaud (le job est re-planifié sans redémarrage). La page **Confidentialité (DPO)** n'en fait qu'un **affichage** — elle rappelle les durées et l'état réel de la purge, et renvoie par le bouton « Régler la purge » ; aucune action destructive ni aucun réglage n'y est possible.

**Pilotage & audit.** Les endpoints `/api/automations/retention` (authentifiés) permettent de :

- `GET` — consulter l'état (fenêtres, activation, heure, dernière exécution et volumes supprimés) ;
- `PATCH` — ajuster les fenêtres, l'activation et l'heure ;
- `POST /retention/run` — déclencher une purge **manuelle immédiate** (garde-fou de confirmation, comme toute action destructive).

Chaque exécution consigne la dernière purge dans la configuration runtime (`automation_purge_last_run_at`, volumes supprimés) et son initiateur (`automation_purge_last_run_by` : `scheduler` pour l'automatique, l'IP/session de l'admin pour un déclenchement manuel), pour traçabilité RGPD.

Les durées par défaut restent à confirmer avec le client selon ses obligations légales, mais le mécanisme de purge lui-même est livré et actif.
