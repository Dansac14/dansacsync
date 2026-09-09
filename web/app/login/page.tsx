// =============================================================================
// Entrada al sistema
// =============================================================================
// Sin registro publico: en un SaaS multi-tenant, un formulario de alta abierto
// crearia usuarios sin empresa asignada que no pueden ver nada y no se sabe de
// donde salieron. Las cuentas las crea el administrador de cada empresa.
// =============================================================================

import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; destino?: string }>;
}) {
  const { error, destino } = await searchParams;

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Synchrony Dansac
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Bandeja de atención. Ingresa con la cuenta que te dio el
            administrador de tu empresa.
          </p>
        </div>

        <form
          action={login}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <input type="hidden" name="destino" value={destino ?? "/inbox"} />

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700">
              Correo
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700">
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white
                       transition hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-300 focus:outline-none"
          >
            Ingresar
          </button>
        </form>
      </div>
    </main>
  );
}
