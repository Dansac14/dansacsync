import { resolverContexto } from "@/lib/tenant";
import { AppShell, PantallaSinAcceso } from "@/components/shell/AppShell";
import { SettingsForm, type Ajustes } from "@/components/settings/SettingsForm";

export const dynamic = "force-dynamic";

export default async function AjustesPage({
  searchParams,
}: {
  searchParams: Promise<{ empresa?: string }>;
}) {
  const { empresa } = await searchParams;
  const resultado = await resolverContexto(empresa);

  if (!resultado.ok) return <PantallaSinAcceso motivo={resultado.motivo} />;
  const { supabase, active, memberships, userEmail, esAdmin } = resultado.contexto;

  const [ajustes, cuentas, documentos] = await Promise.all([
    supabase.from("company_settings").select("*").eq("tenant_id", active.tenant_id).single(),
    supabase.from("channel_accounts")
      .select("id, channel, display_name, external_account_id, phone_number, is_active, last_event_at, access_token_secret_name")
      .eq("tenant_id", active.tenant_id)
      .order("channel"),
    supabase.from("knowledge_documents")
      .select("id, title, status, chunk_count, updated_at")
      .eq("tenant_id", active.tenant_id)
      .order("updated_at", { ascending: false }),
  ]);

  if (ajustes.error || !ajustes.data) {
    return (
      <PantallaSinAcceso
        motivo={
          `Esta empresa no tiene configuración: ${ajustes.error?.message ?? "sin datos"}. ` +
          `Debió crearse con provision_tenant al dar de alta la empresa.`
        }
      />
    );
  }

  return (
    <AppShell actual="/ajustes" active={active} memberships={memberships} userEmail={userEmail}>
      <SettingsForm
        ajustesIniciales={ajustes.data as Ajustes}
        esAdmin={esAdmin}
        cuentas={(cuentas.data ?? []) as never}
        documentos={(documentos.data ?? []) as never}
      />
    </AppShell>
  );
}
