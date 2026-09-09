// =============================================================================
// Resolucion de usuario y empresa en el servidor
// =============================================================================
// Lo usan todas las paginas con sesion. Centralizarlo evita que una pagina
// nueva se olvide de comprobar la membresia y muestre datos de otra empresa.
// =============================================================================

import { createSupabaseServerClient } from "./supabase/server";
import type { Membership } from "./types";

export interface Contexto {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  userEmail: string;
  memberships: Membership[];
  active: Membership;
  esAdmin: boolean;
}

export type Resultado =
  | { ok: true; contexto: Contexto }
  | { ok: false; motivo: string };

export async function resolverContexto(slug?: string): Promise<Resultado> {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, motivo: "Sesión no válida. Vuelve a ingresar." };

  // El filtro por user_id es imprescindible. La politica de tenant_members
  // permite ver a todos los miembros activos de la empresa —hace falta para el
  // panel de equipo—, asi que sin este filtro la consulta devolvia una fila por
  // companero: el selector de empresa aparecia con la misma empresa repetida, y
  // `role` y `esAdmin` se tomaban de la fila de OTRA persona. Un operador veia
  // los formularios de administrador y recibia errores crudos al guardar.
  const { data, error } = await supabase
    .from("tenant_members")
    .select("tenant_id, role, display_name, tenants(id, business_name, slug)")
    .eq("user_id", user.id)
    .eq("status", "active");

  if (error) return { ok: false, motivo: `No se pudo leer tu acceso: ${error.message}` };

  const memberships = (data ?? []) as unknown as Membership[];
  if (memberships.length === 0) {
    return {
      ok: false,
      motivo: "Tu cuenta existe pero todavía no pertenece a ninguna empresa. " +
              "Pide al administrador que te agregue.",
    };
  }

  const active = memberships.find((m) => m.tenants?.slug === slug) ?? memberships[0]!;

  return {
    ok: true,
    contexto: {
      supabase,
      userId: user.id,
      userEmail: user.email ?? "",
      memberships,
      active,
      // Catálogo, configuración y gastos son de administración. La RLS ya lo
      // impone; esto solo evita mostrar botones que van a fallar.
      esAdmin: active.role === "owner" || active.role === "admin",
    },
  };
}
