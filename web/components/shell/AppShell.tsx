// =============================================================================
// Marco de las pantallas de gestion
// =============================================================================
// El Inbox tiene su propio marco de pantalla completa. Catalogo, ordenes,
// finanzas y ajustes comparten este, con la navegacion arriba.
// =============================================================================

import Link from "next/link";
import { logout } from "@/app/login/actions";
import type { Membership } from "@/lib/types";

const SECCIONES = [
  { href: "/inbox",    etiqueta: "Bandeja" },
  { href: "/ordenes",  etiqueta: "Órdenes" },
  { href: "/catalogo", etiqueta: "Catálogo" },
  { href: "/finanzas", etiqueta: "Finanzas" },
  { href: "/ajustes",  etiqueta: "Ajustes" },
] as const;

export function AppShell({
  actual, active, memberships, userEmail, children,
}: {
  actual: string;
  active: Membership;
  memberships: Membership[];
  userEmail: string;
  children: React.ReactNode;
}) {
  const slug = active.tenants?.slug;
  // El slug viaja en la URL para que cambiar de empresa no dependa de un estado
  // de sesion invisible: la direccion dice siempre qué empresa se está viendo.
  const con = (href: string) =>
    memberships.length > 1 && slug ? `${href}?empresa=${slug}` : href;

  return (
    <div className="min-h-full">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2.5">
          <span className="truncate text-sm font-semibold text-slate-900">
            {active.tenants?.business_name ?? "Empresa"}
          </span>

          <nav className="flex items-center gap-1">
            {SECCIONES.map((seccion) => {
              const activa = actual === seccion.href;
              return (
                <Link
                  key={seccion.href}
                  href={con(seccion.href)}
                  aria-current={activa ? "page" : undefined}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                    activa
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {seccion.etiqueta}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {memberships.length > 1 && (
              <form method="get">
                <label htmlFor="empresa" className="sr-only">Empresa</label>
                <select
                  id="empresa"
                  name="empresa"
                  defaultValue={slug ?? ""}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700"
                >
                  {memberships.map((m) => (
                    <option key={m.tenant_id} value={m.tenants?.slug ?? ""}>
                      {m.tenants?.business_name ?? m.tenant_id}
                    </option>
                  ))}
                </select>
                <button type="submit" className="ml-1 text-xs text-indigo-600 underline">
                  cambiar
                </button>
              </form>
            )}

            <span className="hidden text-xs text-slate-500 lg:inline">
              {userEmail} · {active.role}
            </span>

            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium
                           text-slate-700 transition hover:bg-slate-50"
              >
                Salir
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}

export function PantallaSinAcceso({ motivo }: { motivo: string }) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Sin acceso</h1>
        <p className="mt-2 text-sm text-slate-600">{motivo}</p>
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
