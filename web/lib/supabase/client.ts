// =============================================================================
// Cliente de Supabase para el navegador
// =============================================================================
// Solo la clave publicable llega aqui. Es publica por diseno: lo que protege
// los datos es la RLS, no el secreto de la clave.
// =============================================================================

"use client";

import { createBrowserClient } from "@supabase/ssr";

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function createSupabaseBrowserClient() {
  // Una sola instancia por pestana: cada cliente abre su propia conexion de
  // tiempo real, y varias instancias significan varias suscripciones al mismo
  // canal y mensajes duplicados en la bandeja.
  cached ??= createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
  return cached;
}
