"""Contrats d'EXPLOITATION des fichiers de déploiement (composes, Dockerfile, scripts).

Ces fichiers ne sont couverts par aucun test d'intégration : on ne construit pas d'image
en CI unitaire. Or leurs régressions sont exactement celles qui réveillent un DSI à 2 h
du matin (sauvegarde inutilisable, disque plein, conteneur `unhealthy` à cause d'un
fournisseur tiers, aucune sortie de secours). On verrouille donc ici les invariants.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
COMPOSES = ("docker-compose.yml", "docker-compose.portainer.yml")
# Les DEUX services de la stack. `postgres` n'est plus un profile optionnel : sans lui le
# moteur ne démarre pas, il doit donc être tenu par les mêmes contrats que `itsm`.
SERVICES = ("itsm", "postgres")


def _texte(nom: str) -> str:
    return (ROOT / nom).read_text(encoding="utf-8")


def _service(compose: str, service: str = "itsm") -> dict:
    return yaml.safe_load(_texte(compose))["services"][service]


def _fonctions_shell(script: str, *noms: str) -> str:
    """Extrait des fonctions shell nommées, pour les EXÉCUTER dans un bac à sable.

    Un test qui cherche un mot dans un script prouve qu'on a écrit le mot, pas que la
    barrière tient. Ces fonctions sont écrites pour être extractibles (accolade fermante en
    colonne 0) et ne dépendre que de `die` — qu'on stube à l'appel.
    """
    texte = _texte(script)
    morceaux = []
    for nom in noms:
        trouve = re.search(rf"^{nom}\(\) \{{.*?^\}}", texte, re.S | re.M)
        assert trouve, f"{script} : fonction `{nom}` introuvable (ou accolade non alignée)"
        morceaux.append(trouve.group(0))
    return "\n".join(morceaux)


@pytest.mark.parametrize("compose", COMPOSES)
def test_healthcheck_never_depends_on_glpi_or_llm(compose):
    """La sonde du conteneur doit rester une sonde de VIVACITÉ.

    `/health?probe=true` toutes les 30 s = ~2 880 sessions GLPI + 2 880 appels LLM par
    jour, et un incident chez le fournisseur marque `unhealthy` un moteur SAIN : sous
    Swarm/k8s/autoheal, c'est un redémarrage en boucle causé par un tiers.
    """
    probe = " ".join(_service(compose)["healthcheck"]["test"])
    assert "/health/live" in probe
    assert "probe=true" not in probe


def test_dockerfile_healthcheck_is_liveness_only():
    healthcheck = _texte("Dockerfile").split("HEALTHCHECK", 1)[1]
    assert "/health/live" in healthcheck


@pytest.mark.parametrize("compose", COMPOSES)
@pytest.mark.parametrize("service", SERVICES)
def test_logs_are_rotated(compose, service):
    """Sans rotation, json-file remplit le disque en quelques mois — et un disque plein
    empêche d'écrire en base, donc de comptabiliser le plafond de coût LLM. PostgreSQL
    logue en plus chaque checkpoint et chaque connexion refusée."""
    options = _service(compose, service)["logging"]["options"]
    assert options["max-size"] and options["max-file"]


@pytest.mark.parametrize("compose", COMPOSES)
@pytest.mark.parametrize("service", SERVICES)
def test_resources_are_bounded(compose, service):
    limits = _service(compose, service)["deploy"]["resources"]["limits"]
    assert limits["cpus"] and limits["memory"]


@pytest.mark.parametrize("compose", COMPOSES)
@pytest.mark.parametrize("service", SERVICES)
def test_le_durcissement_couvre_les_deux_services(compose, service):
    """La base porte les données RGPD : la laisser hors du durcissement appliqué au moteur
    n'aurait aucun sens (elle était jusqu'ici un profile optionnel, donc hors contrat)."""
    conf = _service(compose, service)
    assert "no-new-privileges:true" in conf["security_opt"]
    assert conf["cap_drop"] == ["ALL"]
    assert conf["cap_add"], "les capabilities strictement nécessaires doivent être listées"


@pytest.mark.parametrize("compose", COMPOSES)
def test_la_base_est_un_service_a_part_entiere(compose):
    """PostgreSQL est la SEULE base supportée : plus de `profiles`, et le moteur attend
    qu'elle soit *healthy* — un conteneur postgres qui vient de démarrer n'accepte pas
    encore les connexions, et `alembic upgrade head` échouerait au premier essai."""
    base = _service(compose, "postgres")
    assert "profiles" not in base, "la base n'est plus optionnelle"
    assert base["healthcheck"]["test"], "sans healthcheck, `service_healthy` est impossible"
    assert _service(compose)["depends_on"]["postgres"]["condition"] == "service_healthy"


@pytest.mark.parametrize("compose", COMPOSES)
def test_la_majeure_postgres_est_epinglee_et_avertie(compose):
    """Un bump de majeure rend le PGDATA existant illisible (« database files are
    incompatible with server ») : le piège doit être écrit LÀ où on modifierait le tag,
    dans les deux fichiers — c'est désormais le chemin nominal, plus une option."""
    texte = _texte(compose)
    assert re.search(r"image:\s*postgres:\d+-alpine", texte), "majeure PostgreSQL non épinglée"
    assert "NE JAMAIS CHANGER LE CHIFFRE MAJEUR" in texte


def _majeure_du_client() -> str:
    """Majeure de RÉFÉRENCE : celle du client `pg_dump`/`pg_restore` embarqué dans l'image."""
    client = re.search(r"postgresql-client-(\d+)", _texte("Dockerfile"))
    assert client, "l'image doit embarquer un client PostgreSQL à la majeure ÉPINGLÉE"
    return client.group(1)


def test_le_client_postgres_de_l_image_suit_la_majeure_du_serveur():
    """Contrat le moins intuitif, et le plus coûteux à rater : `pg_dump` produit les
    sauvegardes (`python -m itsm_modern_ai.backup`) DEPUIS l'image du moteur. Une archive
    `custom` écrite par pg_dump 17 est illisible par un pg_restore 16 (« unsupported
    version in file header »), et un pg_restore 17 pointé sur un serveur 16 échoue sur
    `SET transaction_timeout`. Un client désaligné fabrique donc des sauvegardes dont on ne
    découvre l'inutilité que le jour de la restauration."""
    client = _majeure_du_client()
    for compose in COMPOSES:
        serveur = re.search(r"image:\s*postgres:(\d+)-alpine", _texte(compose))
        assert serveur.group(1) == client, f"{compose} : serveur et client désalignés"


# Fichiers de CI qui démarrent un vrai PostgreSQL. Ils sont hors des composes, donc hors du
# test ci-dessus — c'est exactement par là que la divergence est entrée (CI en 16 pendant
# que le produit livrait du 17).
#
# ⚠️ UNIQUEMENT DES FICHIERS VERSIONNÉS. `.gitlab-ci.yml` a figuré ici : il existe sur le
# poste de développement mais vit dans `.git/info/exclude`, donc un `actions/checkout` ne
# l'a JAMAIS. Le test passait en local et échouait sur `FileNotFoundError` dans TOUTE PR —
# le pire des verrous, celui qui rougit sans rapport avec ce qu'on cherchait à protéger.
# (GitLab est abandonné depuis 0.9.54 : GitHub est le seul forge.) L'itération reste
# tolérante à un fichier absent, pour que le même piège ne puisse pas revenir en silence.
FICHIERS_CI = (".github/workflows/ci.yml", ".github/workflows/docker-publish.yml")


def test_aucun_fichier_verrouille_ici_n_est_hors_du_depot():
    """Un contrat ne peut porter que sur des fichiers que la CI reçoit.

    Ce module lit des fichiers du dépôt : s'ils ne sont pas versionnés, la PR est rouge chez
    tout le monde alors que tout va bien. C'est arrivé avec `.gitlab-ci.yml`, présent sur le
    poste de développement mais listé dans `.git/info/exclude` — vert en local,
    `FileNotFoundError` dans tout `actions/checkout`. On prend donc `git` comme arbitre :
    un fichier local non suivi ne peut plus devenir un contrat par distraction.
    """
    depot = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    if depot.returncode != 0:
        pytest.skip("hors d'un dépôt git (archive/export) : rien à arbitrer")
    lus = sorted({
        *FICHIERS_CI, *COMPOSES,
        "Dockerfile", "Makefile", ".env.example", "install.sh", "docker/entrypoint.sh",
        "src/itsm_modern_ai/backup.py",
    })
    suivis = subprocess.run(
        ["git", "ls-files", "--error-unmatch", *lus],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert suivis.returncode == 0, (
        "fichier verrouillé par ce module mais NON versionné (absent d'un actions/checkout) : "
        f"{suivis.stderr.strip()}"
    )


def test_la_majeure_postgres_de_la_ci_suit_celle_du_produit():
    """La CI doit éprouver la majeure LIVRÉE, pas une autre.

    Sans ce verrou, la divergence revient en silence : une CI en `postgres:16` reste verte
    alors que les composes et l'image livrent du 17, et elle valide donc une combinaison que
    personne n'exploite. Pire, elle rend FAUX les tests de sauvegarde : `tests/unit/test_backup.py`
    fait tourner le `pg_dump`/`pg_restore` de l'image contre le serveur de la CI, et un couple
    désaligné casse la restauration dans les deux sens (archive 17 illisible par un restore 16 ;
    restore 17 contre un serveur 16 qui échoue sur `SET transaction_timeout`). On mesure donc
    la CI contre la même référence que les composes : la majeure du client de l'image.
    """
    client = _majeure_du_client()
    verifies = 0
    for fichier in FICHIERS_CI:
        chemin = ROOT / fichier
        if not chemin.is_file():
            # Un fichier de CI absent du checkout n'est pas une régression du produit : on
            # ne le lit pas plutôt que de rougir sur un `FileNotFoundError` sans rapport.
            continue
        verifies += 1
        texte = chemin.read_text(encoding="utf-8")
        # Toutes les formes de tag (`postgres:17`, `17-alpine`, `17.4-alpine`) OÙ QU'ELLES
        # soient — `image:` d'un service, ou un `docker run` de smoke test.
        # Le garde `(?![\w.])` écarte les `postgres:5432` des URL de connexion.
        tags = re.findall(r"postgres:(\d{1,2})(?:\.\d+)?(?:-alpine)?(?![\w.])", texte)
        # `postgresql-client-<majeure>` : docker-publish installe le client sur le runner.
        tags += re.findall(r"postgresql-client-(\d+)", texte)
        assert tags, f"{fichier} : aucun PostgreSQL épinglé — la CI doit tourner sur un vrai serveur"
        desalignes = {tag for tag in tags if tag != client}
        assert not desalignes, (
            f"{fichier} : PostgreSQL {sorted(desalignes)} alors que le produit livre du "
            f"{client} — la CI testerait une combinaison non livrée"
        )
    assert verifies, "aucun fichier de CI vérifié — le verrou ne protégerait plus rien"


def test_l_etape_client_postgres_met_le_bon_binaire_sur_le_chemin_et_le_verifie():
    """Installer un client n'est pas l'aligner : encore faut-il que ce soit LUI qui réponde.

    Le test ci-dessus vérifie que la CI *installe* `postgresql-client-<majeure du produit>`.
    Il a été vert pendant que la CI tournait avec un client 16 : PGDG dépose ses binaires
    dans `/usr/lib/postgresql/<majeure>/bin`, mais `/usr/bin/pg_dump` reste celui de la 16
    PRÉINSTALLÉE sur le runner `ubuntu-24.04`. L'étape s'achevait donc en vert sur un
    `pg_dump --version` affichant `16.14`, sans que rien ne s'en émeuve — et les huit tests
    de sauvegarde tombaient en erreur cent secondes plus tard, avec un message qui accusait
    le code de la PR.

    Deux conditions, donc, et ce sont deux conditions distinctes :
      1. le répertoire de la bonne majeure est ajouté au `PATH` du job (`$GITHUB_PATH`) ;
      2. l'étape VÉRIFIE la majeure obtenue et échoue elle-même sinon.

    Sans (2), une étape peut de nouveau affirmer un alignement qu'elle n'a pas constaté —
    c'est précisément ce qui s'est produit, et c'est la raison d'être de ce verrou.
    """
    client = _majeure_du_client()
    verifies = 0
    for fichier in FICHIERS_CI:
        chemin = ROOT / fichier
        if not chemin.is_file():
            continue
        texte = chemin.read_text(encoding="utf-8")
        if "postgresql-client-" not in texte:
            # Ce workflow n'installe pas de client : rien à aligner ici.
            continue
        verifies += 1
        assert f'echo "/usr/lib/postgresql/{client}/bin" >> "$GITHUB_PATH"' in texte, (
            f"{fichier} : le client {client} est installé mais son répertoire n'est pas mis "
            "sur le PATH du job — c'est le pg_dump préinstallé du runner qui répondra"
        )
        # La vérification doit être BLOQUANTE et porter sur la majeure attendue.
        assert re.search(r"majeure=.*pg_dump --version", texte), (
            f"{fichier} : l'étape n'inspecte pas la majeure réellement obtenue"
        )
        assert re.search(rf'test "\$majeure" = "{client}"', texte), (
            f"{fichier} : l'étape ne vérifie pas que pg_dump est bien en {client} — elle "
            "peut donc réussir en laissant un client désaligné, comme elle l'a déjà fait"
        )
    assert verifies, "aucune étape d'installation de client PostgreSQL trouvée dans la CI"


def test_le_pgdata_ne_partage_pas_le_volume_applicatif():
    """Deux cycles de vie distincts, et surtout : l'entrypoint du moteur fait un `chown` du
    volume applicatif. PostgreSQL REFUSE de démarrer si son PGDATA ne lui appartient pas —
    un chown de trop et la base entière part en crash-loop."""
    sources = _service("docker-compose.yml", "postgres")["volumes"]
    assert sources == ["./data/postgres:/var/lib/postgresql/data"]
    # … d'où l'exclusion, qui doit survivre à toute réécriture de l'entrypoint.
    assert "! -name postgres" in _texte("docker/entrypoint.sh")

    portainer = yaml.safe_load(_texte("docker-compose.portainer.yml"))
    assert portainer["services"]["postgres"]["volumes"] == ["itsm_pgdata:/var/lib/postgresql/data"]
    assert set(portainer["volumes"]) == {"itsm_data", "itsm_pgdata"}


def test_l_entrypoint_attend_la_base_avant_de_migrer():
    """Sans attente, `alembic upgrade head` échoue à la première seconde du premier
    `up -d` (le cluster n'accepte pas encore les connexions), `set -e` tue le conteneur et
    l'exploitant lit un crash-loop au lieu d'un démarrage. L'attente doit être BORNÉE :
    une base durablement injoignable est une panne à diagnostiquer, pas à attendre en
    silence."""
    entrypoint = _texte("docker/entrypoint.sh")
    # `\nalembic` : la COMMANDE en début de ligne, pas la mention dans le commentaire d'en-tête.
    assert entrypoint.index("attendre_la_base") < entrypoint.index("\nalembic upgrade head"), \
        "on attend AVANT de migrer"
    assert "plafond" in entrypoint, "l'attente doit avoir un plafond (jamais de boucle infinie)"
    assert "exit 1" in entrypoint, "l'échec doit être explicite"


def test_la_sauvegarde_est_livree_DANS_le_paquet():
    """L'invariant qui compte pour un exploitant : pouvoir sauvegarder **sans les sources**.

    La voie recommandée est *pull-only* (image GHCR, Portainer, `docker run`, one-liner) :
    tant que la logique ne vivait que dans le `Makefile`, quiconque suivait la documentation
    n'avait AUCUN moyen de sauvegarder — sur une base contenant les données RGPD, dont le
    volume porte la `master.key` sans laquelle elle est définitivement illisible.
    """
    module = ROOT / "src" / "itsm_modern_ai" / "backup.py"
    assert module.is_file(), "la sauvegarde doit être livrée dans l'image, pas dans le Makefile"
    code = module.read_text(encoding="utf-8")
    assert "pg_dump" in code and "--format=custom" in code  # instantané cohérent, à chaud
    assert "master.key" in code  # sans elle, la base restaurée est illisible
    # … et VÉRIFIÉE, en DEUX temps : la structure (l'archive est relisible et n'a pas perdu
    # de table) PUIS le contenu (toutes les données sont relues et recomptées). Le premier
    # contrôle seul accepterait une archive saine mais vide — le trou exact que le comptage
    # des lignes bouchait déjà à l'époque de `PRAGMA integrity_check`.
    assert "--list" in code
    assert "--data-only" in code


def test_l_image_embarque_de_quoi_sauvegarder():
    """Sans `pg_dump` dans l'image, un déploiement pull-only n'a plus AUCUN moyen de
    sauvegarder : c'est le trou que 0.9.56 avait bouché."""
    assert "postgresql-client" in _texte("Dockerfile")


def test_le_makefile_delegue_au_paquet_sans_dupliquer():
    """Deux implémentations de la sauvegarde divergeraient — et c'est celle de l'exploitant,
    la moins testée, qui casserait. La cible Make n'est qu'un raccourci."""
    makefile = _texte("Makefile")
    backup = makefile.split("\nbackup:", 1)[1].split("\nlint:", 1)[0]
    assert "itsm_modern_ai.backup" in backup
    assert "cp -a data/postgres" not in backup  # copier un PGDATA à chaud reste banni
    assert "|| true" not in backup  # un échec de sauvegarde doit être BRUYANT


def test_installer_offers_a_rollback_path():
    """docs/install.md promet « le script affiche la procédure de rollback » : sans
    `--rollback`, revenir à l'image précédente sans restaurer la base fait boucler
    l'entrypoint sur `Can't locate revision identified by …`."""
    installer = _texte("install.sh")
    assert "--rollback" in installer
    assert "--list-backups" in installer
    # Une mise à jour ratée ne doit JAMAIS laisser l'instance à l'arrêt (le
    # `up -d --force-recreate` peut échouer après avoir détruit le conteneur).
    assert "trap restore_service_on_failure EXIT" in installer


def test_l_installeur_refuse_de_mettre_a_jour_sans_sauvegarde():
    """Une sauvegarde ratée qui ne produit qu'un `warn` fait perdre la garantie de pouvoir
    revenir en arrière — et l'exploitant ne lit l'avertissement qu'après coup."""
    corps = _texte("install.sh").split("\nbackup_data() {", 1)[1].split("\n}", 1)[0]
    assert "pg_dump_verifie" in corps
    assert "die " in corps, "l'échec de sauvegarde doit interrompre la mise à jour"


def _corps_du_rollback() -> str:
    """Corps de `do_rollback`, COMMENTAIRES RETIRÉS.

    Les commentaires de ce script expliquent longuement les pièges qu'il évite — dont
    `--clean` : les laisser dans la matière du test ferait échouer un contrat sur la seule
    présence d'une explication.
    """
    corps = _texte("install.sh").split("\ndo_rollback() {", 1)[1].split("\n  exit 0\n}", 1)[0]
    return "\n".join(ligne for ligne in corps.splitlines() if not ligne.lstrip().startswith("#"))


def test_le_rollback_restaure_reellement_la_base():
    """Afficher une marche à suivre `psql` n'est pas un retour arrière : à 2 h du matin, la
    restauration doit être faite par le script — après confirmation, car elle écrase."""
    corps = _corps_du_rollback()
    assert "pg_restore" in corps
    assert "--exit-on-error" in corps, "une restauration à moitié faite est pire que refusée"
    assert "ÉCRASÉE" in corps, "l'écrasement doit être confirmé explicitement"
    assert "pre-rollback-" in corps, "l'état d'avant doit rester récupérable"


def test_le_rollback_remet_le_schema_a_plat_au_lieu_de_pg_restore_clean():
    """`--clean` ne nettoie QUE ce que l'archive contient — donc pas assez.

    Défaut mesuré : une table créée par une migration POSTÉRIEURE à la sauvegarde survit à
    `pg_restore --clean --if-exists`, pendant qu'`alembic_version` est rembobiné. Le
    rollback rend 0, et c'est la mise à jour suivante qui meurt sur
    `DuplicateTable: relation "technician_absences" already exists` — entrypoint en
    `set -euo pipefail`, donc boucle de redémarrage et console inaccessible. L'ère SQLite
    ne pouvait pas avoir ce défaut : elle remplaçait le FICHIER entier. On exige donc la
    propriété équivalente : schéma vide, puis archive.
    """
    corps = _corps_du_rollback()
    assert "--clean" not in corps, "`--clean` laisse en place les objets absents de l'archive"
    assert "DROP SCHEMA" in corps and "CREATE SCHEMA public" in corps
    # … et JAMAIS avant d'avoir un dump de sécurité vérifié : l'ordre fait toute la valeur
    # de la manœuvre (sans lui, la remise à plat est un aller simple).
    assert corps.index("pg_dump_verifie") < corps.index("DROP SCHEMA")
    assert corps.index("DROP SCHEMA") < corps.index("pg_restore")


def test_le_rollback_ne_se_confirme_pas_tout_seul():
    """La confirmation doit être une BARRIÈRE, pas une formalité.

    `ask` répond oui sur Entrée, oui avec `--yes`, et oui toute seule hors TTY : inoffensif
    quand elle gardait un `mv` réversible, plus du tout depuis qu'elle garde un
    `pg_restore` destructif. Le rollback passe donc par `confirmer_ecrasement`, qui exige
    une saisie EXACTE et refuse de trancher sans terminal.
    """
    corps = _corps_du_rollback()
    assert "confirmer_ecrasement" in corps
    assert "\n  ask " not in corps, "aucune décision destructive ne passe par `ask`"

    fonction = _texte("install.sh").split("\nconfirmer_ecrasement() {", 1)[1].split("\n}", 1)[0]
    assert "$ASSUME_YES" not in fonction, "`--yes` ne doit pas armer une destruction"
    assert 'die ' in fonction, "hors TTY, on s'arrête au lieu d'inventer une réponse"
    assert '"$r" = "$attendu"' in fonction, "il faut TAPER la réponse, pas valider par Entrée"


def test_le_rollback_refuse_quand_l_etat_courant_n_est_pas_sauvegardable():
    """Pas de dump de sécurité = pas de retour en arrière du retour en arrière.

    L'ancien code AVERTISSAIT que l'opération serait irréversible… puis reposait une
    question complaisante : hors TTY, la base était écrasée sans une seule invite. Un dump
    impossible n'est pas une question, c'est un motif de refus.
    """
    corps = _corps_du_rollback()
    echec = corps.split("if pg_dump_verifie", 1)[1].split("\n  fi", 1)[0].split("else", 1)[1]
    assert "die " in echec, "l'échec du dump pré-rollback doit interrompre, pas demander"
    assert "ask " not in echec


def test_l_installeur_refuse_un_pgdata_d_une_autre_majeure(tmp_path):
    """Un bump de majeure sur un PGDATA existant = panne totale, sans diagnostic lisible.

    `postgres` n'est plus optionnel et démarre donc tout seul : après un bump 16 → 17, le
    conteneur boucle sur « database files are incompatible with server », n'atteint jamais
    `healthy`, et `depends_on: service_healthy` empêche le moteur de démarrer. On exige donc
    que l'installeur LISE `data/postgres/PG_VERSION` et refuse AVANT le `up -d`, avec la
    procédure. Le test exécute réellement la fonction, sur un faux PGDATA.
    """
    fonctions = _fonctions_shell(
        "install.sh", "majeure_postgres_du_compose", "majeure_du_pgdata", "verifier_majeure_postgres"
    )
    (tmp_path / "docker-compose.yml").write_text(
        "services:\n  postgres:\n    image: postgres:17-alpine\n", encoding="utf-8"
    )
    (tmp_path / "data" / "postgres").mkdir(parents=True)
    version = tmp_path / "data" / "postgres" / "PG_VERSION"

    def _lancer() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "-c", f'die() {{ echo "$*" >&2; exit 1; }}\n{fonctions}\nverifier_majeure_postgres'],
            cwd=tmp_path, capture_output=True, text=True, check=False,
        )

    version.write_text("16\n", encoding="utf-8")
    refus = _lancer()
    assert refus.returncode == 1, "un cluster PG 16 sous une stack PG 17 doit être REFUSÉ"
    assert "16" in refus.stderr and "17" in refus.stderr
    assert "pg_dump" in refus.stderr, "le refus doit porter la procédure, pas seulement le constat"

    version.write_text("17\n", encoding="utf-8")
    assert _lancer().returncode == 0, "une majeure alignée ne doit rien bloquer"

    # Pas de cluster local du tout (base externe, volume nommé) : rien à vérifier, on passe.
    version.unlink()
    assert _lancer().returncode == 0


def test_l_entrypoint_garde_aussi_la_majeure_du_pgdata(tmp_path):
    """Repli pour les topologies sans `depends_on` : le moteur démarre pendant que la base
    refuse de naître. Sans ce garde, l'exploitant lit 120 s d'« injoignable » au lieu de la
    vraie cause. Lu AVANT le passage en `app` (PGDATA en 0700, seul root le lit)."""
    entrypoint = _texte("docker/entrypoint.sh")
    assert entrypoint.index("verifier_majeure_pgdata\n") < entrypoint.index("exec gosu app")

    fonctions = _fonctions_shell("docker/entrypoint.sh", "verifier_majeure_pgdata")
    (tmp_path / "app" / "data" / "postgres").mkdir(parents=True)
    (tmp_path / "app" / "data" / "postgres" / "PG_VERSION").write_text("16\n", encoding="utf-8")
    # `pg_dump` est simulé : c'est le client EMBARQUÉ dans l'image qui sert de référence,
    # et sa majeure est déjà tenue égale à celle du serveur par un contrat plus haut.
    faux_pg_dump = 'pg_dump() { echo "pg_dump (PostgreSQL) 17.10 (Debian 17.10-0+deb13u1)"; }\n'
    lance = subprocess.run(
        ["bash", "-c", faux_pg_dump + fonctions.replace("/app/data", str(tmp_path / "app" / "data"))
         + "\nverifier_majeure_pgdata"],
        capture_output=True, text=True, check=False,
    )
    assert lance.returncode == 1
    assert "incompatible" in lance.stderr or "16" in lance.stderr


# ── Compte administrateur : créé à la PREMIÈRE VISITE, plus par l'environnement ────────
# Ces contrats ont remplacé l'amorçage par variable. L'ancien monde posait
# `ITSM_ADMIN_PASSWORD` dans les composes, l'entrypoint la lisait au boot, et le smoke test
# de publication cherchait « compte admin amorcé » dans les logs. Tout cela est mort — mais
# « mort » n'est pas un état que la CI constate toute seule : un `environment:` oublié
# donnerait une variable inerte que l'exploitant croirait active, ce qui est pire que
# l'absence, puisqu'il déploierait en croyant son compte protégé.
FICHIERS_D_EXPLOITATION = (
    *COMPOSES,
    ".env.example",
    "install.sh",
    "docker/entrypoint.sh",
    "Makefile",
    "Dockerfile",
    ".github/workflows/docker-publish.yml",
)


@pytest.mark.parametrize("fichier", FICHIERS_D_EXPLOITATION)
def test_aucun_mot_de_passe_admin_ne_transite_plus_par_l_environnement(fichier):
    """Aucune trace d'`ITSM_ADMIN_PASSWORD` / `ADMIN_PASSWORD` dans l'exploitation.

    Le moteur ne lit plus AUCUN mot de passe dans l'environnement : ni `Settings`
    (le champ a disparu), ni la CLI `admin_setup` (stdin ou saisie masquée uniquement).
    Une variable qui subsisterait dans un compose ou un `.env.example` serait donc un
    LEURRE : l'exploitant la renseignerait, ne verrait aucune erreur, et découvrirait à la
    première visite que n'importe qui a pu créer le compte avant lui.
    """
    texte = _texte(fichier)
    assert "ADMIN_PASSWORD" not in texte, (
        f"{fichier} : `ADMIN_PASSWORD` n'est plus lu par le moteur — la laisser ici fait "
        "croire à un amorçage qui n'existe plus"
    )


def test_l_entrypoint_n_amorce_plus_le_compte_admin():
    """L'entrypoint ne doit plus appeler `admin_setup` en écriture au boot.

    `--check` resterait inoffensif ; c'est l'écriture qui n'a plus de sens (aucune source de
    mot de passe non-interactive). Le garde de majeure PostgreSQL et l'attente de la base,
    eux, sont intacts — ils sont vérifiés par les contrats voisins.
    """
    entrypoint = _texte("docker/entrypoint.sh")
    lignes = [
        ligne for ligne in entrypoint.splitlines()
        if "admin_setup" in ligne and not ligne.lstrip().startswith("#")
    ]
    assert not lignes, f"l'entrypoint amorce encore le compte admin : {lignes}"
    # … et la contrepartie est ANNONCÉE là où l'exploitant la lira (le WARNING de démarrage
    # vit dans api/security.py ; ici on exige au moins que le fichier dise pourquoi il ne
    # fait plus rien, sinon la prochaine régression sera de le « réparer »).
    assert "premi" in entrypoint.lower() and "auth/setup" in entrypoint


def test_le_smoke_test_de_publication_exerce_la_creation_du_compte():
    """La publication doit être bloquée par le PARCOURS, pas par un message de log.

    L'ancien smoke test faisait `grep "compte admin amorcé"` dans `docker logs` : il ne
    prouvait que l'existence d'une ligne. Il serait resté vert avec un hash illisible, une
    base en lecture seule ou un `/api/auth/login` cassé — et il est devenu franchement
    nuisible le jour où le message a disparu, puisqu'il aurait empêché TOUTE publication.
    On exige donc les quatre points du contrat public.
    """
    workflow = _texte(".github/workflows/docker-publish.yml")
    assert "/api/auth/setup" in workflow, "le smoke test doit créer le compte pour de vrai"
    assert "/api/auth/login" in workflow, "… et vérifier qu'on peut s'y connecter ensuite"
    assert "409" in workflow, "un second /api/auth/setup doit être REFUSÉ (fail-closed)"
    assert "setup_required" in workflow
    # L'ancien verrou, nommément banni : il ne doit pas revenir par copier-coller.
    assert "compte admin amorcé" not in workflow


def test_l_installeur_renvoie_vers_l_ecran_de_creation_du_compte():
    """Un installeur qui se termine sans dire où créer son compte laisse l'exploitant
    devant une console qui lui demande des identifiants qu'il n'a jamais choisis.

    Et il doit dire l'autre moitié : tant que le compte n'existe pas, l'instance est
    revendicable. C'est le seul moment où l'exploitant lit encore la sortie du script.
    """
    installeur = _texte("install.sh")
    # Plus de porte dure « pas de mot de passe = refus de terminer » : elle exigeait un
    # amorçage devenu impossible, et aurait fait échouer toute installation.
    assert "No admin password configured" not in installeur
    assert "Admin password" not in installeur
    final = installeur.split("== Installation reussie ==", 1)[1]
    assert "creer le compte administrateur" in final.lower() or "creer le compte" in final.lower()
    assert "port" in final.lower() and "publiquement" in final.lower(), (
        "la conclusion doit avertir de ne pas exposer le port avant la création du compte"
    )
    assert "--reset-password" in final, "la récupération doit être annoncée AVANT d'en avoir besoin"


def test_la_recuperation_de_mot_de_passe_delegue_a_la_cli_avec_les_bons_drapeaux():
    """`--reset-password` est désormais le SEUL chemin de récupération : il doit marcher.

    Deux pièges que ce contrat ferme : (1) réimplémenter le hachage côté shell — la CLI est
    la seule source de vérité ; (2) appeler la CLI sans `--email` sur une base SANS compte,
    où elle refuse (un compte sans adresse ne pourrait jamais se connecter, le login
    comparant le couple email + mot de passe).
    """
    corps = _texte("install.sh").split("\nreset_admin_password() {", 1)[1].split("\n}", 1)[0]
    assert "itsm_modern_ai.admin_setup" in corps or "run_admin_setup" in corps
    assert "--force" in corps, "changer un mot de passe existant exige --force"
    assert "--email" in corps, "créer un compte sans adresse est refusé par la CLI"
    assert "admin_is_set" in corps, "les deux cas (compte existant / absent) doivent différer"


@pytest.mark.parametrize(
    ("compte_existe", "attendu"),
    [
        # Compte présent, aucun terminal : le mot de passe ne peut PAS être saisi (il n'est
        # plus lu dans l'environnement) — on doit le dire, pas rendre un « non modifié » muet.
        (True, "Pas de terminal interactif"),
        # Aucun compte : rien à réinitialiser, on renvoie vers la console au lieu d'inventer
        # une adresse (la CLI refuserait, et un compte sans adresse ne se connecterait jamais).
        (False, "creez le compte depuis la console"),
    ],
)
def test_la_recuperation_refuse_proprement_sans_terminal(compte_existe, attendu):
    """La fonction est EXÉCUTÉE, pas seulement lue.

    Piège mesuré : `[ -w /dev/tty ]` est **vrai** dans un conteneur de CI (le nœud existe et
    ses droits passent) alors que l'ouvrir échoue, faute de terminal de contrôle. La branche
    « on a un terminal » était donc prise à tort, et l'exploitant lisait « mot de passe non
    modifié » au lieu de la vraie cause. On exige la même détection que `ask` :
    `[ -r /dev/tty ] && [ -t 1 ]`.
    """
    fonctions = _fonctions_shell("install.sh", "run_admin_setup", "reset_admin_password")
    stub = (
        'c_yel=""; c_off=""\n'
        'say() { :; }\nwarn() { echo "$*"; }\n'
        'die() { echo "$*" >&2; exit 1; }\n'
        'docker() { return 0; }\n'
        f'admin_is_set() {{ return {0 if compte_existe else 1}; }}\n'
    )
    lance = subprocess.run(
        ["bash", "-c", stub + fonctions + "\nreset_admin_password"],
        capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL,
    )
    assert lance.returncode == 1, "sans terminal, on s'arrête au lieu de faire semblant"
    assert attendu in (lance.stdout + lance.stderr)


def test_le_makefile_ne_reimplemente_pas_la_recuperation():
    """`make set-admin-password` reste un raccourci vers la CLI livrée dans l'image."""
    makefile = _texte("Makefile")
    cible = makefile.split("\nset-admin-password:", 1)[1].split("\n\n", 1)[0]
    assert "itsm_modern_ai.admin_setup" in cible
    assert "--force" in cible
    # Sur une base vierge la CLI exige une adresse : la cible doit pouvoir en passer une,
    # sinon `make set-admin-password` échoue sans issue sur une instance jamais revendiquée.
    assert "EMAIL" in cible


def test_env_example_donne_une_stack_coherente():
    """`install.sh` copie .env.example en .env : si le mot de passe du cluster et celui de
    l'URL du moteur divergent, l'instance ne se connecte pas à sa propre base au 1er boot.
    Ces deux variables se contredisent en silence — le test les tient ensemble."""
    env = dict(
        ligne.split("=", 1)
        for ligne in _texte(".env.example").splitlines()
        if ligne and not ligne.startswith("#") and "=" in ligne
    )
    attendu = f"postgresql+psycopg://{env['POSTGRES_USER']}:{env['POSTGRES_PASSWORD']}@postgres:5432/{env['POSTGRES_DB']}"
    assert env["ITSM_DATABASE_URL"] == attendu
    # Un mot de passe par défaut qui n'invite pas à le changer serait gardé tel quel.
    assert env["POSTGRES_PASSWORD"] not in ("itsm", "postgres", "changeme")


@pytest.mark.parametrize("script", ["install.sh", "docker/entrypoint.sh"])
def test_shell_scripts_parse(script):
    assert subprocess.run(["bash", "-n", str(ROOT / script)], check=False).returncode == 0
