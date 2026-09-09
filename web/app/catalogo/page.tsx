import { resolverContexto } from "@/lib/tenant";
import { AppShell, PantallaSinAcceso } from "@/components/shell/AppShell";
import { CatalogManager } from "@/components/catalog/CatalogManager";

export const dynamic = "force-dynamic";

export default async function CatalogoPage({
  searchParams,
}: {
  searchParams: Promise<{ empresa?: string }>;
}) {
  const { empresa } = await searchParams;
  const resultado = await resolverContexto(empresa);

  if (!resultado.ok) return <PantallaSinAcceso motivo={resultado.motivo} />;
  const { supabase, active, memberships, userEmail, esAdmin } = resultado.contexto;

  // Las tres consultas son independientes: van juntas para no encadenar tres
  // viajes a la base antes de pintar la pagina.
  const [categorias, productos, ajustes] = await Promise.all([
    supabase.from("catalog_categories")
      .select("id, name").eq("tenant_id", active.tenant_id).order("name"),
    supabase.from("products")
      .select("id, category_id, sku, name, description, price, currency, tax_rate, images, track_stock, stock_quantity, is_active")
      .eq("tenant_id", active.tenant_id).order("name"),
    supabase.from("company_settings")
      .select("default_currency").eq("tenant_id", active.tenant_id).single(),
  ]);

  return (
    <AppShell actual="/catalogo" active={active} memberships={memberships} userEmail={userEmail}>
      <CatalogManager
        tenantId={active.tenant_id}
        esAdmin={esAdmin}
        categoriasIniciales={categorias.data ?? []}
        productosIniciales={(productos.data ?? []) as never}
        monedaEmpresa={ajustes.data?.default_currency ?? "PEN"}
      />
    </AppShell>
  );
}
