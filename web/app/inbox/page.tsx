// =============================================================================
// Bandeja · carga inicial en el servidor
// =============================================================================
// Este componente resuelve quien es el operador y a que empresa esta mirando.
// Los datos que cambian solos (conversaciones y mensajes) los carga y mantiene
// el componente cliente, porque necesita la suscripcion de tiempo real.
// =============================================================================

import { resolverContexto } from "@/lib/tenant";
import { logout } from "../login/actions";
import { InboxShell } from "@/components/inbox/InboxShell";
import type { Group } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ empresa?: string }>;
}) {
  const { empresa } = await searchParams;

  // Se usa el mismo resolutor que las demas pantallas. Antes esta pagina
  // repetia la consulta de membresias por su cuenta y sin filtrar por usuario,
  // asi que traia una fila por companero de empresa: el selector aparecia con
  // la misma empresa repetida y el rol se tomaba de la fila de otra persona.
  const resultado = await resolverContexto(empresa);
  if (!resultado.ok) return <SinAcceso mensaje={resultado.motivo} />;

  const { supabase, userId, userEmail, memberships, active } = resultado.contexto;

  const [grupos, productos] = await Promise.all([
    supabase.from("groups")
      .select("id, name, color, system_key")
      .eq("tenant_id", active.tenant_id)
      .order("name"),
    // Catalogo activo, para poder enviar una ficha sin salir de la conversacion.
    supabase.from("products")
      .select("id, name, sku, price, currency, track_stock, stock_quantity, images")
      .eq("tenant_id", active.tenant_id)
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <InboxShell
      userId={userId}
      userEmail={userEmail}
      memberships={memberships}
      active={active}
      groups={(grupos.data ?? []) as Group[]}
      productos={(productos.data ?? []) as never}
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
