import { resolverContexto } from "@/lib/tenant";
import { AppShell, PantallaSinAcceso } from "@/components/shell/AppShell";
import { FinanceDashboard, type Resumen } from "@/components/finance/FinanceDashboard";

export const dynamic = "force-dynamic";

export default async function FinanzasPage({
  searchParams,
}: {
  searchParams: Promise<{ empresa?: string }>;
}) {
  const { empresa } = await searchParams;
  const resultado = await resolverContexto(empresa);

  if (!resultado.ok) return <PantallaSinAcceso motivo={resultado.motivo} />;
  const { supabase, active, memberships, userEmail, esAdmin } = resultado.contexto;

  // Periodo por defecto: el mes en curso, que es la unidad con la que se
  // declara y con la que piensa cualquiera que abra esta pantalla.
  const hoy = new Date();
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10);
  const hasta = hoy.toISOString().slice(0, 10);

  const [resumen, gastos, comprobantes, ajustes] = await Promise.all([
    supabase.rpc("financial_summary", {
      p_tenant_id: active.tenant_id, p_from: desde, p_to: hasta,
    }),
    supabase.from("purchases_and_expenses")
      .select("id, supplier_name, supplier_tax_id, document_kind, document_number, category, currency, subtotal, tax_amount, total, expense_date")
      .eq("tenant_id", active.tenant_id)
      .gte("expense_date", desde).lte("expense_date", hasta)
      .order("expense_date", { ascending: false }),
    supabase.from("sales_invoices")
      .select("id, full_number, kind, state, receiver_name, receiver_tax_id, currency, total, issued_at")
      .eq("tenant_id", active.tenant_id)
      .gte("issued_at", `${desde}T00:00:00`)
      .lte("issued_at", `${hasta}T23:59:59.999`)
      .order("issued_at", { ascending: false })
      .limit(500),
    supabase.from("company_settings")
      .select("default_currency, tax_rate_default")
      .eq("tenant_id", active.tenant_id).single(),
  ]);

  const fila = (Array.isArray(resumen.data) ? resumen.data[0] : resumen.data) as Resumen | null;

  return (
    <AppShell actual="/finanzas" active={active} memberships={memberships} userEmail={userEmail}>
      <FinanceDashboard
        tenantId={active.tenant_id}
        esAdmin={esAdmin}
        moneda={ajustes.data?.default_currency ?? "PEN"}
        tasaIgv={Number(ajustes.data?.tax_rate_default ?? 0.18)}
        resumenInicial={fila}
        desdeInicial={desde}
        hastaInicial={hasta}
        gastosIniciales={(gastos.data ?? []) as never}
        comprobantesIniciales={(comprobantes.data ?? []) as never}
      />
    </AppShell>
  );
}
