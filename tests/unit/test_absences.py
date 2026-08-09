"""Congés et remplaçants (FR-15) — retirer du pool, transmettre les compétences."""

from __future__ import annotations

from datetime import date, timedelta

from itsm_modern_ai.persistence import db
from itsm_modern_ai.persistence.tables import ReferentialCache, TechnicianAbsence
from itsm_modern_ai.services import absences, referentials


def _tech(ext_id: int, name: str, *, tags: str = "", eligible: bool = True, prose: str = ""):
    with db.session_scope() as s:
        s.add(
            ReferentialCache(
                kind="technician", ext_id=ext_id, name=name, eligible=eligible,
                skill_tags=tags, skills=prose,
            )
        )
        s.commit()


def _absence(ext_id: int, debut: date, fin: date, *, remplacant: int | None = None):
    with db.session_scope() as s:
        s.add(
            TechnicianAbsence(
                technician_ext_id=ext_id, start_date=debut, end_date=fin,
                replacement_ext_id=remplacant,
            )
        )
        s.commit()


# Ancré sur le jour RÉEL du fuseau par défaut : `routing_prose` et
# `effective_referentials` appellent `today_local()` eux-mêmes, une date figée dans le test
# ne recouvrirait donc jamais leur « aujourd'hui ».
AUJOURDHUI = absences.today_local()
HIER = AUJOURDHUI - timedelta(days=1)
DEMAIN = AUJOURDHUI + timedelta(days=1)


def test_bornes_inclusives(temp_db):
    """« Du 10 au 22 » inclut le 22 : un congé qui s'arrête la veille du dernier jour est
    la faute la plus banale — et la plus invisible — de ce genre de fonctionnalité."""
    _tech(11, "Adrien")
    _absence(11, AUJOURDHUI, AUJOURDHUI)
    with db.session_scope() as s:
        assert absences.absent_ext_ids(s, AUJOURDHUI) == {11}
        assert absences.absent_ext_ids(s, HIER) == set()
        assert absences.absent_ext_ids(s, DEMAIN) == set()


def test_absent_sort_du_perimetre_effectif(temp_db):
    """Approche retenue : FILTRER la whitelist, jamais corriger la Décision après coup —
    ce qui créerait une divergence entre le Journal et ce que GLPI reçoit."""
    _tech(11, "Adrien")
    _tech(12, "Nadia")
    _absence(11, AUJOURDHUI, AUJOURDHUI)
    with db.session_scope() as s:
        # `today_local` est figé par le test via une absence encadrant la date du jour réel.
        absents = absences.absent_ext_ids(s, AUJOURDHUI)
    assert absents == {11}


def test_absence_expire_toute_seule(temp_db):
    """Aucune réactivation manuelle : le périmètre est reconstruit à chaque cycle, donc
    l'absence cesse d'elle-même — personne n'a à y penser le lundi matin."""
    _tech(11, "Adrien")
    _absence(11, AUJOURDHUI - timedelta(days=10), HIER)
    with db.session_scope() as s:
        assert absences.absent_ext_ids(s, AUJOURDHUI) == set()


def test_remplacant_herite_des_competences(temp_db):
    """LE point qui décide si la fonctionnalité marche ou fait semblant.

    Dire au modèle « route vers B » sans lui dire POURQUOI B convient, c'est lui demander
    d'assigner du réseau à quelqu'un décrit comme faisant de la bureautique : confiance
    basse, puis rejet par le seuil. On aurait déplacé le problème, pas résolu.
    """
    _tech(11, "Adrien Durand", tags="network,servers_backup")
    _tech(12, "Nadia", tags="workstation")
    _absence(11, HIER, DEMAIN, remplacant=12)
    with db.session_scope() as s:
        prose = referentials.routing_prose(s)

    assert "Adrien Durand" not in prose.split("Technicien 12")[0]  # l'absent n'est plus décrit
    bloc = [b for b in prose.split("\n\n") if b.startswith("Technicien 12")][0]
    assert "Poste de travail" in bloc  # ses propres domaines
    assert "Réseau & Wifi" in bloc and "Serveurs & sauvegarde" in bloc  # ceux hérités
    assert "Assure l'intérim de Adrien Durand jusqu'au" in bloc


def test_interim_annonce_en_dernier_apres_la_prose(temp_db):
    """L'intérim est l'information la plus fraîche : c'est la dernière lue, donc celle qui
    pèse le plus — même logique que la prose placée après le socle coché."""
    _tech(11, "Adrien", tags="network")
    _tech(12, "Nadia", tags="workstation", prose="Ne gère pas les Mac.")
    _absence(11, AUJOURDHUI - timedelta(days=1), AUJOURDHUI + timedelta(days=1), remplacant=12)
    with db.session_scope() as s:
        bloc = [b for b in referentials.routing_prose(s).split("\n\n") if b.startswith("Technicien 12")][0]
    assert bloc.index("Domaines") < bloc.index("Ne gère pas les Mac") < bloc.index("Assure l'intérim")


def test_un_seul_saut_pas_de_resolveur_de_graphe(temp_db):
    """A→B avec B absent : on ne cherche PAS le remplaçant de B. Le comportement doit être
    compréhensible par un admin qui débarque, pas mathématiquement complet."""
    _tech(11, "A", tags="network")
    _tech(12, "B", tags="printing")
    _tech(13, "C", tags="messaging")
    _absence(11, HIER, DEMAIN, remplacant=12)
    _absence(12, HIER, DEMAIN, remplacant=13)
    with db.session_scope() as s:
        interims = absences.interim_context(s, AUJOURDHUI)
    # B est absent : il ne remplace personne. C remplace B, mais n'hérite PAS de A.
    assert interims == {13: [12]}


def test_sans_remplacant_l_absent_sort_simplement_du_pool(temp_db):
    _tech(11, "Adrien", tags="network")
    _absence(11, HIER, DEMAIN)
    with db.session_scope() as s:
        assert absences.interim_context(s, AUJOURDHUI) == {}
        assert "Technicien 11" not in referentials.routing_prose(s)


def test_fuseau_inconnu_ne_bloque_pas_le_triage(temp_db):
    """Une faute de frappe dans un réglage ne doit pas arrêter le triage de toute une file."""
    assert isinstance(absences.today_local("Mars/Olympus_Mons"), date)
    assert absences.today_local("") == absences.today_local(absences.DEFAULT_TIMEZONE)


def test_fuseau_local_decide_du_jour(temp_db):
    """Évalué en UTC, un congé se terminerait à 02 h du matin le bon jour (ou la veille
    selon la saison) pour une équipe à Paris. Ne se voit qu'en production, en août."""
    # Pacific/Kiritimati (UTC+14) est toujours en avance sur Pacific/Niue (UTC-11).
    assert absences.today_local("Pacific/Kiritimati") >= absences.today_local("Pacific/Niue")


def test_purge_ne_supprime_que_les_absences_terminees(temp_db):
    """RGPD : une absence passée est une donnée personnelle sans utilité opérationnelle.
    Une absence EN COURS est de la configuration active — jamais purgée."""
    _tech(11, "A")
    _absence(11, date(2020, 1, 1), date(2020, 1, 10))  # terminée depuis longtemps
    _absence(11, HIER, DEMAIN)  # en cours
    with db.session_scope() as s:
        assert absences.purge_ended_before(s, AUJOURDHUI - timedelta(days=30)) == 1
        restantes = absences.list_absences(s)
    assert len(restantes) == 1 and restantes[0].end_date == DEMAIN
