// =============================================================================
// Tipos del Inbox
// =============================================================================
// Reflejan el esquema de la base. Cuando el proyecto Supabase exista, estos
// tipos se pueden regenerar con:
//   supabase gen types typescript --project-id <ref> > lib/database.types.ts
// =============================================================================

export type Channel = "whatsapp" | "instagram" | "facebook" | "tiktok";
export type SenderType = "contact" | "bot" | "operator" | "system";
export type HandlingMode = "bot" | "human";
export type ConversationStatus = "open" | "pending" | "resolved";
export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type MediaType =
  | "text" | "image" | "video" | "audio" | "document" | "sticker"
  | "location" | "contact_card" | "template" | "interactive" | "unsupported";
export type TenantRole = "owner" | "admin" | "operator" | "viewer";

export interface Membership {
  tenant_id: string;
  role: TenantRole;
  display_name: string | null;
  tenants: { id: string; business_name: string; slug: string } | null;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  system_key: string | null;
}

export interface ConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: Channel;
  status: ConversationStatus;
  handling_mode: HandlingMode;
  assigned_operator_id: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  service_window_expires_at: string | null;
  contacts: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  channel_identities: {
    channel_user_id: string;
    display_name: string | null;
  } | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_type: SenderType;
  sender_user_id: string | null;
  content: string | null;
  media_type: MediaType;
  media_url: string | null;
  media_mime_type: string | null;
  delivery_status: DeliveryStatus;
  error_text: string | null;
  created_at: string;
}

export interface ContactGroupRow {
  group_id: string;
  groups: Group | null;
}

/** Nombre visible de un contacto, con degradado razonable de alternativas. */
export function contactLabel(conversation: ConversationRow): string {
  const contact = conversation.contacts;
  const full = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;

  const identity = conversation.channel_identities?.display_name?.trim();
  if (identity) return identity;

  if (contact?.phone) return contact.phone;

  // Ultimo recurso: el identificador del canal. Es lo unico que se sabe de un
  // contacto nuevo de Instagram, donde el perfil no llega con el mensaje.
  const channelUser = conversation.channel_identities?.channel_user_id;
  return channelUser ? `Contacto ${channelUser.slice(-6)}` : "Contacto sin nombre";
}

/** true cuando la ventana de 24 h de WhatsApp ya se cerro. */
export function serviceWindowClosed(conversation: ConversationRow): boolean {
  if (conversation.channel !== "whatsapp") return false;
  if (!conversation.service_window_expires_at) return true;
  return new Date(conversation.service_window_expires_at).getTime() < Date.now();
}
