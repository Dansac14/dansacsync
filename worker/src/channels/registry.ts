// =============================================================================
// Registro de canales
// =============================================================================

import type { Channel } from "../db.ts";
import { ChannelError, type ChannelDriver } from "./types.ts";
import { whatsappDriver } from "./whatsapp.ts";
import { messengerDriver, instagramDriver } from "./meta-messaging.ts";
import { tiktokDriver } from "./tiktok.ts";

const DRIVERS: Record<Channel, ChannelDriver> = {
  whatsapp: whatsappDriver,
  facebook: messengerDriver,
  instagram: instagramDriver,
  tiktok: tiktokDriver,
};

export function driverFor(channel: Channel): ChannelDriver {
  const driver = DRIVERS[channel];
  if (!driver) {
    throw new ChannelError(`Canal no reconocido: ${channel}`, { permanent: true });
  }
  return driver;
}

export { ChannelError };
