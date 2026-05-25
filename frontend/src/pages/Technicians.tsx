import { Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";

export function Technicians() {
  const profiles = useResource(useCallback(() => Api.techProfiles(), []));
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [error, setError] = useState("");

  async function add() {
    setError("");
    const tid = Number(id);
    if (!tid || !profile.trim()) {
      setError("ID technicien (numérique) et fiche sont requis.");
      return;
    }
    try {
      await Api.saveTechProfile(tid, name, profile);
      setId("");
      setName("");
      setProfile("");
      profiles.reload();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Fiches techniciens"
        description="Décrites en langage naturel (prose), utilisées pour le routage. L'ID doit correspondre à un technicien GLPI."
      />

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 p-6">
          <div className="grid grid-cols-2 gap-4">
            <Field label="ID technicien GLPI">
              <Input value={id} type="number" placeholder="11" onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label="Nom (optionnel)">
              <Input value={name} placeholder="Sylvain" onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Fiche (prose libre)">
            <Textarea
              value={profile}
              placeholder="Expert Active Directory, comptes et accès, sécurité réseau (VPN, phishing)…"
              onChange={(e) => setProfile(e.target.value)}
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div>
            <Button onClick={add}>
              <Plus className="h-4 w-4" /> Ajouter / mettre à jour
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {profiles.data?.map((p) => (
          <Card key={p.technician_id}>
            <CardContent className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="font-semibold">
                  #{p.technician_id} — {p.name || "(sans nom)"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{p.profile}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={async () => {
                  await Api.deleteTechProfile(p.technician_id);
                  profiles.reload();
                }}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </CardContent>
          </Card>
        ))}
        {profiles.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucune fiche. Ajoutez vos techniciens ci-dessus.</p>
        )}
      </div>
    </>
  );
}
