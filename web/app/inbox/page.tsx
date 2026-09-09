// =============================================================================
// Bandeja · carga inicial en el servidor
// =============================================================================
// Este componente resuelve quien es el operador y a que empresa esta mirando.
// Los datos que cambian solos (conversaciones y mensajes) los carga y mantiene
// el componente cliente, porque necesita la suscripcion de tiempo real.
// =============================================================================

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logout } from "../login/actions";
import { InboxShell } from "@/components/inbox/InboxShell";
import type { Group, Membership } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ empresa?: string }>;
}) {
  const { empresa } = await searchParams;
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // El middleware ya redirige, pero el componente no debe asumirlo.
    return <SinAcceso mensaje="Sesión no válida. Vuelve a ingresar." />;
  }

  // Empresas donde este usuario es miembro activo. La RLS ya limita la
  // consulta: no hace falta filtrar por user_id.
  const { data: membershipsData, error: membershipsError } = await supabase
    .from("tenant_members")
    .select("tenant_id, role, display_name, tenants(id, business_name, slug)")
    .eq("status", "active");

  if (membershipsError) {
    return <SinAcceso mensaje={`No se pudo leer tu acceso: ${membershipsError.message}`} />;
  }

  const memberships = (membershipsData ?? []) as unknown as Membership[];

  if (memberships.length === 0) {
    return (
      <SinAcceso
        mensaje="Tu cuenta existe pero todavía no pertenece a ninguna empresa. Pide al administrador que te agregue."
      />
    );
  }

  const active =
    memberships.find((m) => m.tenants?.slug === empresa) ?? memberships[0]!;

  const { data: groupsData } = await supabase
    .from("groups")
    .select("id, name, color, system_key")
    .eq("tenant_id", active.tenant_id)
    .order("name");

  return (
    <InboxShell
      userId={user.id}
      userEmail={user.email ?? ""}
      memberships={memberships}
      active={active}
      groups={(groupsData ?? []) as Group[]}
      onLogout={logout}
    />
  );
}

function SinAcceso({ mensaje }: { mensaje: string }) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Sin acceso a la bandeja</h1>
        <p className="mt-2 text-sm text-slate-600">{mensaje}</p>
        <form action={logout} className="mt-6">
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            Salir
          </button>
        </form>
      </div>
    </main>
  );
}
