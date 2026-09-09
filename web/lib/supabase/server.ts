// =============================================================================
// Cliente de Supabase para el servidor
// =============================================================================
// Usa la clave publicable y la sesion del usuario, nunca la clave de servicio.
// Consecuencia importante: toda consulta que salga de aqui pasa por la RLS. Si
// una politica esta mal, el resultado es una pantalla vacia, no una fuga.
// =============================================================================

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Los Server Components no pueden escribir cookies. La renovacion
            // de la sesion la hace el middleware, asi que aqui se ignora.
          }
        },
      },
    },
  );
}
