import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Entrar — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Acesse o planejamento financeiro CUPOLA 2027." },
      { property: "og:title", content: "Entrar — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Acesse o planejamento financeiro CUPOLA 2027." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleForgot() {
    setError(null);
    if (!/.+@.+\..+/.test(email)) {
      setError("Digite seu e-mail acima e clique de novo em “Esqueci minha senha”.");
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/definir-senha`,
    });
    if (error) setError(error.message);
    else setNotice(`Se ${email} tiver acesso, você vai receber um link para criar uma nova senha.`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("E-mail ou senha inválidos.");
      return;
    }
    navigate({ to: "/inicio" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <img src="/brand/cupola.png" alt="CUPOLA" className="mb-2 h-9 w-auto self-start" />
          <CardTitle className="titulo-marca text-xl">Planejamento financeiro</CardTitle>
          <CardDescription>Ano 2027 — entre com seu e-mail e senha.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Entrando…" : "Entrar"}
            </Button>
            <button
              type="button"
              onClick={handleForgot}
              className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Esqueci minha senha
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
