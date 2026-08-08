"""Catalogue des domaines de compétence d'un service IT (routage, FR-15).

POURQUOI CE CATALOGUE EXISTE. Le routage repose sur les **fiches en prose** des
techniciens — c'est le différenciateur du produit. Mais `routing_prose` n'inclut que les
techniciens dont la fiche est REMPLIE : à l'installation, tant que l'admin n'a rien écrit,
le LLM reçoit une liste de noms sans la moindre description et route sur un patronyme. Il
s'en tire mal, et le seuil de confiance rejette ses propositions — observé en conditions
réelles : 7 rejets `low_confidence` sur 20 décisions, sur une instance dont les fiches
étaient vides.

Ces domaines cochables donnent donc un **socle exploitable en quelques clics**, le jour de
l'installation, sans rédiger une ligne. La prose reste indispensable pour tout ce qui ne se
coche pas — « ne gère pas les Mac », « référent SAP », « astreinte le week-end » — et le
prompt la place APRÈS le socle, pour qu'elle prime en cas de contradiction.

Module PUR (aucune I/O) : c'est du contenu produit, versionné avec le code, pas une donnée
de configuration. Les clés sont STABLES — elles sont stockées en base ; renommer une clé
casserait les sélections existantes. Les libellés, eux, peuvent évoluer librement.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SkillDomain:
    """Un domaine de compétence cochable.

    `hint` n'est pas décoratif : il est envoyé au LLM avec le libellé, pour lever les
    ambiguïtés entre domaines voisins (« Réseau » vs « VPN », « Comptes » vs « Sécurité »).
    C'est ce qui permet à un technicien coché de devenir réellement discriminant.
    """

    key: str
    label_fr: str
    label_en: str
    hint_fr: str


# Ordre = ordre d'affichage : du plus fréquent en support N1 au plus spécialisé.
SKILL_CATALOG: tuple[SkillDomain, ...] = (
    SkillDomain("workstation", "Poste de travail", "Workstation",
                "PC, portables, système, pilotes, lenteurs, écrans, périphériques"),
    SkillDomain("printing", "Impression", "Printing",
                "imprimantes, copieurs, files d'impression, scan"),
    SkillDomain("network", "Réseau & Wifi", "Network & Wi-Fi",
                "connectivité, Wifi, switches, DHCP/DNS, câblage"),
    SkillDomain("remote_access", "VPN & accès distant", "VPN & remote access",
                "VPN, télétravail, bureau à distance, passerelles"),
    SkillDomain("messaging", "Messagerie", "Messaging",
                "Outlook/Exchange, boîtes partagées, spam, listes de diffusion"),
    SkillDomain("telephony", "Téléphonie", "Telephony",
                "postes fixes, ToIP, standard, renvois d'appel"),
    SkillDomain("accounts", "Comptes & droits", "Accounts & permissions",
                "création/départ, Active Directory, mots de passe, partages et droits"),
    SkillDomain("business_apps", "Applications métier", "Business applications",
                "logiciels internes, applications spécifiques au métier"),
    SkillDomain("erp_finance", "ERP & comptabilité", "ERP & finance",
                "ERP, paie, comptabilité, exports comptables, facturation"),
    SkillDomain("security", "Sécurité", "Security",
                "antivirus, phishing, incidents de sécurité, chiffrement"),
    SkillDomain("mobility", "Mobilité", "Mobility",
                "smartphones, tablettes, MDM, forfaits"),
    SkillDomain("servers_backup", "Serveurs & sauvegarde", "Servers & backup",
                "serveurs, virtualisation, sauvegardes, restaurations"),
    SkillDomain("physical_access", "Accès physique & badges", "Physical access & badges",
                "badges, contrôle d'accès, vidéosurveillance"),
    SkillDomain("licensing", "Licences & achats", "Licensing & procurement",
                "licences logicielles, commandes de matériel, devis"),
)

KNOWN_SKILLS: frozenset[str] = frozenset(d.key for d in SKILL_CATALOG)
_BY_KEY: dict[str, SkillDomain] = {d.key: d for d in SKILL_CATALOG}


def normalize(keys: object) -> list[str]:
    """Ne garde que les clés CONNUES, dédupliquées, dans l'ordre du catalogue.

    Défensif par nécessité : ces clés viennent de l'API (donc du client) et sont relues
    depuis une base qui peut porter des sélections d'une version antérieure du catalogue.
    Une clé inconnue est IGNORÉE plutôt que de faire échouer l'enregistrement — perdre une
    case cochée est préférable à empêcher un admin de sauvegarder son périmètre.
    """
    if not isinstance(keys, (list, tuple, set)):
        return []
    retenues = {str(k) for k in keys} & KNOWN_SKILLS
    return [d.key for d in SKILL_CATALOG if d.key in retenues]


def describe(keys: list[str]) -> str:
    """Rend les compétences cochées telles qu'elles seront lues par le LLM.

    Le `hint` accompagne le libellé : sans lui, « Réseau » et « VPN » se confondent et le
    modèle hésite entre deux techniciens — exactement la confiance basse qu'on cherche à
    faire disparaître.
    """
    return " ; ".join(f"{_BY_KEY[k].label_fr} ({_BY_KEY[k].hint_fr})" for k in normalize(keys))
