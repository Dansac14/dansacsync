import { resolverContexto } from "@/lib/tenant";
import { AppShell, PantallaSinAcceso } from "@/components/shell/AppShell";
import { OrdersManager } from "@/components/orders/OrdersManager";

export const dynamic = "force-dynamic";

export default async function OrdenesPage({
  searchParams,
}: {
  searchParams: Promise<{ empresa?: string }>;
}) {
  const { empresa } = await searchParams;
  const resultado = await resolverContexto(empresa);

  if (!resultado.ok) return <PantallaSinAcceso motivo={resultado.motivo} />;
  const { supabase, active, memberships, userEmail } = resultado.contexto;

  const [ordenes, contactos, productos, ajustes] = await Promise.all([
    supabase.from("orders")
      .select(`id, order_number, contact_id, status, currency, subtotal, tax_amount, total,
               paid_at, created_at, public_token,
               contacts(first_name, last_name, phone),
               sales_invoices(id, full_number, kind, state, total)`)
      .eq("tenant_id", active.tenant_id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("contacts")
      .select("id, first_name, last_name, phone, tax_id_number, tax_name")
      .eq("tenant_id", active.tenant_id)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("products")
      .select("id, name, sku, price, currency, tax_rate, track_stock, stock_quantity")
      .eq("tenant_id", active.tenant_id)
      .eq("is_active", true)
      .order("name"),
    supabase.from("company_settings")
      .select("default_currency, receipt_series_default, invoice_series_default, public_store_url")
      .eq("tenant_id", active.tenant_id)
      .single(),
  ]);

  return (
    <AppShell actual="/ordenes" active={active} memberships={memberships} userEmail={userEmail}>
      <OrdersManager
        tenantId={active.tenant_id}
        ordenesIniciales={(ordenes.data ?? []) as never}
        contactos={(contactos.data ?? []) as never}
        productos={(productos.data ?? []) as never}
        monedaEmpresa={ajustes.data?.default_currency ?? "PEN"}
        serieBoleta={ajustes.data?.receipt_series_default ?? "B001"}
        serieFactura={ajustes.data?.invoice_series_default ?? "F001"}
        urlTienda={ajustes.data?.public_store_url ?? null}
      />
    </AppShell>
  );
}
