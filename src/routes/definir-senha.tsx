import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { pageHead } from "@/lib/head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/definir-senha")({
  ssr: false,
  head: pageHead("Definir senha", "Crie a sua senha de acesso."),
  component: DefinirSenhaPage,
});

/** Destino dos links de convite e de "esqueci minha senha": a sessão vem no link. */
function DefinirSenhaPage() {
  const navigate = useNavigate();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("A senha precisa de pelo menos 8 caracteres.");
    if (password !== confirm) return setError("As senhas não conferem.");
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) return setError(error.message);
    navigate({ to: "/inicio" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <img src="/brand/cupola.png" alt="CUPOLA" className="mb-2 h-9 w-auto self-start" />
          <CardTitle className="titulo-marca text-xl">Defina sua senha</CardTitle>
          <CardDescription>Ela será usada para entrar no planejamento financeiro.</CardDescription>
        </CardHeader>
        <CardContent>
          {hasSession === false ? (
            <p className="text-sm text-muted-foreground">
              O link expirou ou já foi usado. Peça um novo convite ao financeiro ou use “Esqueci
              minha senha” na tela de entrada.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="password">Nova senha</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Repita a senha</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={saving || hasSession === null}>
                {saving ? "Salvando…" : "Salvar e entrar"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
