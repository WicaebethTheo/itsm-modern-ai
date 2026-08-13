"""Contrats d'EXPLOITATION des fichiers de déploiement (composes, Dockerfile, scripts).

Ces fichiers ne sont couverts par aucun test d'intégration : on ne construit pas d'image
en CI unitaire. Or leurs régressions sont exactement celles qui réveillent un DSI à 2 h
du matin (sauvegarde inutilisable, disque plein, conteneur `unhealthy` à cause d'un
fournisseur tiers, aucune sortie de secours). On verrouille donc ici les invariants.
"""

from __future__ import annotations

import os
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


# Stub minimal pour EXÉCUTER une fonction d'`install.sh` en bac à sable. `die` doit sortir
# en erreur : c'est lui qui distingue « la barrière a tenu » de « la barrière a cédé ».
STUB_SHELL = 'say() { :; }\nwarn() { :; }\ndie() { echo "$*" >&2; exit 1; }\n'


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


def test_les_workflows_qui_lancent_la_suite_pointent_la_MEME_base():
    """Deux workflows lancent la meme suite : ils doivent la cabler pareil.

    Defaut mesure sur la publication de 0.9.80 : `ci.yml` publiait PostgreSQL sur le port
    5432 et `docker-publish.yml` sur 55432. Or une poignee de modules construisent
    l'application — donc `Settings` — a l'IMPORT : ils ne voient jamais `TEST_DATABASE_URL`
    et retombent sur le defaut du code, `localhost:5432`. La CI passait donc par
    COINCIDENCE (son service ecoutait sur ce meme port), pendant que la publication
    echouait sur vingt erreurs de collecte « BASE INJOIGNABLE » — la release a ete creee
    sans que l'image ne soit jamais construite.

    On exige donc que les DEUX variables soient posees explicitement, et qu'elles designent
    le port REELLEMENT publie par le service. Plus rien ne doit reposer sur un defaut.
    """
    for fichier in FICHIERS_CI:
        chemin = ROOT / fichier
        if not chemin.is_file():
            continue
        conf = yaml.safe_load(chemin.read_text(encoding="utf-8"))
        for nom, job in conf["jobs"].items():
            service = (job.get("services") or {}).get("postgres")
            if not service:
                continue
            # UNIQUEMENT les jobs qui lancent la SUITE. Le job `migrations` a lui aussi une
            # base, mais il joue Alembic avec ses propres URL (`URL_VIDE`, `URL_PEUPLEE`) et
            # ne charge jamais `Settings` par defaut : lui imposer ce contrat serait exiger
            # des variables qui n'ont aucun sens pour lui.
            etapes = " ".join(str(e.get("run", "")) for e in job.get("steps", []))
            if "pytest" not in etapes:
                continue
            env = job.get("env") or {}
            for variable in ("TEST_DATABASE_URL", "DATABASE_URL"):
                assert variable in env, (
                    f"{fichier}:{nom} lance un PostgreSQL sans poser {variable} — la suite "
                    "retomberait sur le defaut du code"
                )
            # Le port publie par le service doit etre celui que les URL designent.
            publie = str(service["ports"][0]).split(":")[0]
            for variable in ("TEST_DATABASE_URL", "DATABASE_URL"):
                assert f"@localhost:{publie}/" in env[variable], (
                    f"{fichier}:{nom} : {variable} ne pointe pas le port {publie} "
                    f"reellement publie ({env[variable]})"
                )


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


def test_le_chown_de_l_entrypoint_epargne_REELLEMENT_le_pgdata(tmp_path):
    """On EXÉCUTE la barrière, on ne la cherche pas au grep.

    Le test ci-dessus se contentait de `"! -name postgres" in _texte(...)`. Or cette chaîne
    figure aussi dans un COMMENTAIRE de l'entrypoint, à dix lignes de là. Mesuré : retirer
    l'exclusion du `find` — donc rendre le `chown -R` récursif sur le PGDATA — laissait les
    54 tests de ce module au vert. C'est pourtant la barrière dont le test voisin dit qu'un
    « chown de trop » fait partir « la base entière en crash-loop » : PostgreSQL refuse de
    démarrer si son PGDATA ne lui appartient pas.

    On extrait donc la commande RÉELLE et on la rejoue sur un faux `/app/data`. Le mot dans
    le commentaire ne peut plus tenir lieu de garde-fou.
    """
    trouve = re.search(
        r"^\s*(find /app/data\b.*?)\s*\|\s*while", _texte("docker/entrypoint.sh"), re.M
    )
    assert trouve, "docker/entrypoint.sh : le `find` du chown est introuvable"

    faux = tmp_path / "data"
    (faux / "postgres").mkdir(parents=True)  # le PGDATA, propriété de l'utilisateur postgres
    (faux / "logs").mkdir()
    (faux / "master.key").write_text("x", encoding="utf-8")

    sortie = subprocess.run(
        ["sh", "-c", trouve.group(1).replace("/app/data", str(faux))],
        capture_output=True, text=True, check=True,
    ).stdout
    listes = {Path(ligne).name for ligne in sortie.split("\n") if ligne.strip()}

    # Le garde-fou lui-même…
    assert "postgres" not in listes, (
        "le chown de l'entrypoint engloberait le PGDATA — PostgreSQL refuserait de démarrer"
    )
    # …et le garde-fou du garde-fou : si la commande extraite ne listait plus rien, la
    # ligne ci-dessus passerait pour de mauvaises raisons.
    assert {"logs", "master.key"} <= listes, "la commande extraite ne liste plus rien"


@pytest.mark.parametrize(
    ("hote", "conseille"),
    [
        pytest.param("localhost", True, id="localhost"),
        pytest.param("127.0.0.1", True, id="ipv4-boucle"),
        pytest.param("", True, id="url-sans-hote"),
        pytest.param("postgres", False, id="service-compose"),
        pytest.param("db.interne.lan", False, id="base-de-la-dsi"),
    ],
)
def test_l_entrypoint_dit_la_verite_a_qui_n_utilise_pas_compose(hote, conseille):
    """Le message d'aide doit s'adresser au chemin RÉELLEMENT pris.

    Le défaut du code est `...@localhost:5432`, pensé pour un `make run` depuis les sources.
    Dans un conteneur, `localhost` désigne CE conteneur, qui n'embarque aucun PostgreSQL :
    un `docker run` sans `DATABASE_URL` ne peut pas aboutir. L'exploitant attendait pourtant
    le plafond entier — soixante tentatives, deux minutes — pour lire ensuite « vérifiez le
    service postgres (docker compose logs postgres) », un conseil qui ne s'applique pas au
    chemin qu'il a pris.

    La fonction est EXÉCUTÉE : chercher le mot « docker run » dans le script prouverait
    qu'on l'a écrit, pas qu'il sort au bon moment ni pour le bon hôte. Et elle ne doit PAS
    parler quand l'hôte est légitime, sinon elle devient un bruit qu'on apprend à ignorer.
    """
    fonctions = _fonctions_shell("docker/entrypoint.sh", "conseil_si_base_locale")
    lance = subprocess.run(
        ["bash", "-c", f'{fonctions}\nconseil_si_base_locale "{hote}"'],
        capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL,
    )
    sortie = lance.stdout + lance.stderr
    if conseille:
        assert "n'embarque aucun PostgreSQL" in sortie, f"aucun conseil pour l'hôte « {hote} »"
        # Les trois issues réelles, pas la seule qui suppose compose.
        assert "docker compose" in sortie and "docker run" in sortie
        # …et le cas légitime `--network host` n'est pas présenté comme une erreur.
        assert "--network host" in sortie
    else:
        assert sortie.strip() == "", f"conseil hors-sujet pour l'hôte « {hote} »"


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
    # Le DISPATCH, pas seulement l'option. Mesuré : supprimer cette ligne laissait le test
    # vert — les chaînes survivent dans l'aide et les messages — et `--rollback` devenait un
    # drapeau mort : on promet un retour arrière qui ne s'exécute jamais.
    assert re.search(r"if \$ROLLBACK; then\s+do_rollback ", installer), (
        "`--rollback` est analysé mais n'appelle plus `do_rollback`"
    )
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
    # CHAQUE commande de restauration doit être gardée, et la garde doit ARRÊTER.
    #
    # La seule présence de `--exit-on-error` ne dit pas que son échec interrompt quoi que ce
    # soit : mesuré, remplacer les `|| die` par des `|| warn` laissait le test vert. Une
    # recherche globale ne suffit pas non plus — le corps contient deux restaurations (dump
    # `custom` et SQL brut hérité) et un seul `|| die` survivant satisfaisait la regex pour
    # les deux. On vérifie donc chaque commande, dans les lignes qui la prolongent.
    arrets = 0
    lignes = corps.splitlines()
    for i, ligne in enumerate(lignes):
        if "--exit-on-error" not in ligne and "ON_ERROR_STOP=1" not in ligne:
            continue
        arrets += 1
        suite = "\n".join(lignes[i : i + 3])
        assert "|| die " in suite, (
            f"restauration non gardée : une restauration à moitié faite est pire que "
            f"refusée, son échec doit interrompre — {ligne.strip()[:70]}"
        )
    assert arrets >= 2, "les deux formats d'archive (custom et SQL brut) doivent être gardés"
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
    assert 'die ' in fonction, "hors TTY, on s'arrête au lieu d'inventer une réponse"
    assert '"$r" = "$attendu"' in fonction, "il faut TAPER la réponse, pas valider par Entrée"


@pytest.mark.parametrize(
    "env",
    [
        pytest.param({"ASSUME_YES": "true"}, id="drapeau---yes"),
        pytest.param({"ITSM_ROLLBACK_CONFIRME": "une-autre-sauvegarde"}, id="mauvais-horodatage"),
        pytest.param({}, id="aucun-terminal"),
    ],
)
def test_la_confirmation_d_ecrasement_EXECUTEE_ne_cede_jamais(env):
    """On EXÉCUTE la barrière, on ne cherche plus un littéral dedans.

    L'assertion précédente était `"$ASSUME_YES" not in fonction`. Mesuré : ajouter
    `[ "${ASSUME_YES:-false}" = true ] && return 0` en tête de la fonction — c'est-à-dire
    faire EXACTEMENT ce que le test interdisait — la laissait VERTE, la forme `${...:-false}`
    ne contenant pas la chaîne cherchée. C'est la barrière d'un `pg_restore` destructif.

    Trois façons de ne pas confirmer, et aucune ne doit passer : le drapeau `--yes` global,
    une variable d'échappement qui désigne une AUTRE sauvegarde, et l'absence de terminal.
    """
    fonctions = _fonctions_shell("install.sh", "confirmer_ecrasement")
    stub = STUB_SHELL + 'c_yel=""; c_off=""\n'
    lance = subprocess.run(
        ["bash", "-c", stub + fonctions + '\nconfirmer_ecrasement 20260101-000000 "Ecraser ?"'],
        capture_output=True,
        text=True,
        check=False,
        stdin=subprocess.DEVNULL,
        env={**os.environ, **env},
    )
    assert lance.returncode != 0, (
        "la confirmation a cédé sans qu'on tape l'horodatage — un pg_restore destructif "
        "serait parti"
    )


def test_l_echec_du_dump_EXECUTE_interrompt_vraiment_la_mise_a_jour(tmp_path):
    """`die ` figurait DEUX fois dans `backup_data` : le test ne distinguait pas les branches.

    Mesuré : remplacer par un `warn` le `die` de la branche « pg_dump a échoué » laissait le
    test vert, l'autre `die` (« base injoignable ») suffisant à le satisfaire. La mise à jour
    aurait donc continué sans sauvegarde exploitable, en n'avertissant qu'après coup — c'est
    précisément ce que le nom de ce test promet d'empêcher.
    """
    fonctions = _fonctions_shell("install.sh", "backup_data")
    stub = STUB_SHELL + (
        "check_add() { :; }\nrecord_backup_metadata() { :; }\n"
        "pg_ready() { return 0; }\n"
        "pg_dump_verifie() { return 1; }\n"  # le dump ECHOUE
    )
    (tmp_path / "data").mkdir()
    lance = subprocess.run(
        ["bash", "-c", stub + fonctions + "\nbackup_data"],
        capture_output=True,
        text=True,
        check=False,
        cwd=tmp_path,
        stdin=subprocess.DEVNULL,
    )
    assert lance.returncode != 0, "un pg_dump raté doit INTERROMPRE la mise à jour"
    assert "ÉCHOUÉE" in (lance.stdout + lance.stderr)


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

    # … ET L'ÉTAPE DOIT POUVOIR ÉCHOUER. Mesuré : poser `if: false` dessus laissait ce test
    # vert — les quatre chaînes restent dans le fichier — et la publication repartait sans
    # qu'aucun parcours ne soit joué. C'est mot pour mot le reproche que la docstring
    # ci-dessus adresse au `grep` qu'elle remplace. On parse donc le YAML.
    etapes = [
        etape
        for job in yaml.safe_load(workflow)["jobs"].values()
        for etape in job.get("steps", [])
        if "Smoke test" in str(etape.get("name", ""))
    ]
    assert etapes, "l'étape de smoke test a disparu du workflow de publication"
    for etape in etapes:
        assert "if" not in etape, "une étape conditionnée peut être sautée sans rien dire"
        assert etape.get("continue-on-error") is not True, "son échec doit bloquer"
        # `|| true` interdit sur les lignes qui VÉRIFIENT (les `curl` du parcours). Il
        # reste légitime dans le nettoyage (`docker rm -f … || true` sur un conteneur qui
        # n'existe pas) : une assertion sur tout le bloc confondait les deux.
        for ligne in etape.get("run", "").splitlines():
            if "curl" in ligne:
                assert "|| true" not in ligne, f"un `|| true` avale l'échec : {ligne.strip()[:60]}"


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


def test_le_port_choisi_survit_REELLEMENT_au_premier_compose_lance_a_la_main(tmp_path):
    """On EXECUTE la persistance du port, on ne la cherche pas au grep.

    `install.sh --port 8080` se contentait d'un `export ITSM_HOST_PORT="$PORT"` : une
    variable du process courant. Le `.env` copie depuis `.env.example` n'en portait aucune
    trace. Consequence mesuree : le premier `docker compose up -d` relance a la main —
    apres un reboot, une mise a jour, n'importe quand — retombait sur le defaut de
    `docker-compose.yml` (`${ITSM_HOST_PORT:-8000}`) et republiait sur 8000. La console
    changeait d'adresse toute seule, sans un message.

    On rejoue donc le bloc REEL de l'installeur sur un faux `.env`, deux fois : une
    premiere ecriture, puis une seconde avec un autre port pour verifier qu'il MET A JOUR
    au lieu d'empiler des lignes contradictoires (la derniere gagnerait, mais un `.env`
    a deux valeurs est un piege pour qui le relit).
    """
    trouve = re.search(
        r"^if grep -q \'\^ITSM_HOST_PORT=\' \.env.*?^fi$",
        _texte("install.sh"),
        re.M | re.S,
    )
    assert trouve, "install.sh : le bloc de persistance de ITSM_HOST_PORT est introuvable"
    bloc = trouve.group(0)

    env = tmp_path / ".env"
    env.write_text("SESSION_HTTPS_ONLY=false\n", encoding="utf-8")

    def rejoue(port: str) -> str:
        subprocess.run(
            ["sh", "-c", f'set -e\nPORT={port}\n{bloc}'],
            cwd=tmp_path, capture_output=True, text=True, check=True,
        )
        return env.read_text(encoding="utf-8")

    apres = rejoue("8080")
    assert "ITSM_HOST_PORT=8080" in apres, (
        "install.sh --port 8080 n'ecrit toujours pas le port dans .env : le premier "
        "`docker compose up -d` lance a la main republiera sur 8000."
    )
    assert "SESSION_HTTPS_ONLY=false" in apres, "l'ecriture a ecrase le reste du .env"

    apres = rejoue("9090")
    assert "ITSM_HOST_PORT=9090" in apres
    assert apres.count("ITSM_HOST_PORT=") == 1, (
        f"deux lignes ITSM_HOST_PORT coexistent dans .env :\n{apres}"
    )
