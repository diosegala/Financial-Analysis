import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

// Attaches the current session's access token to every server function call.
// The server validates the bearer; reading the session client-side is fine here.
export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
