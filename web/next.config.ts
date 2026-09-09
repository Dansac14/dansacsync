import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // El Inbox no muestra imagenes de dominios arbitrarios: los archivos de los
  // canales se sirven con URL firmada del propio Supabase Storage.
  images: { remotePatterns: [{ protocol: "https", hostname: "*.supabase.co" }] },
};

export default config;
