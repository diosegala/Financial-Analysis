import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { pageHead } from "@/lib/head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: pageHead("Entrar", "Acesse o planejamento financeiro CUPOLA."),
  component: AuthPage,
});

/** Domínio do Google Workspace sugerido na tela de escolha de conta (ex.: cupola.com.br). */
const WORKSPACE_DOMAIN = import.meta.env["VITE_GOOGLE_WORKSPACE_DOMAIN"] as string | undefined;

/** Erro devolvido pelo Supabase no retorno do Google (?error_description=… ou #error_description=…). */
function oauthError(): string | null {
  const params = new URLSearchParams(window.location.search + "&" + window.location.hash.slice(1));
  const raw = params.get("error_description");
  if (!raw) return null;
  if (/signups? not allowed|not allowed for this instance/i.test(raw))
    return "Seu e-mail ainda não tem acesso ao planejamento. Peça ao financeiro para cadastrá-lo.";
  return raw;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setError(oauthError());
    // Retorno do Google com sessão válida: segue para o app.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/inicio", replace: true });
    });
  }, [navigate]);

  async function signInWithGoogle() {
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth`,
        queryParams: {
          prompt: "select_account",
          ...(WORKSPACE_DOMAIN ? { hd: WORKSPACE_DOMAIN } : {}),
        },
      },
    });
    if (error) {
      setLoading(false);
      setError(error.message);
    }
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
          <CardDescription>Entre com a sua conta Google da CUPOLA.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button className="w-full gap-2" onClick={signInWithGoogle} disabled={loading}>
            <GoogleIcon /> Entrar com Google
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}

          {showPassword ? (
            <form onSubmit={handleSubmit} className="space-y-4 border-t border-border pt-4">
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
              <Button type="submit" variant="outline" className="w-full" disabled={loading}>
                {loading ? "Entrando…" : "Entrar com e-mail e senha"}
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setShowPassword(true)}
              className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Não tenho conta Google da CUPOLA
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
