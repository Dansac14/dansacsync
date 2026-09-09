"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const destino = String(formData.get("destino") ?? "/inbox");

  if (!email || !password) {
    redirect(`/login?error=${encodeURIComponent("Completa correo y contraseña")}`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // El mensaje al usuario no distingue entre correo inexistente y contrasena
    // incorrecta: decirlo permitiria averiguar que cuentas existen.
    redirect(`/login?error=${encodeURIComponent("Correo o contraseña incorrectos")}`);
  }

  revalidatePath("/", "layout");
  // Solo se acepta una ruta interna: un destino con host propio convertiria
  // este formulario en un redirector hacia sitios de terceros.
  redirect(destino.startsWith("/") && !destino.startsWith("//") ? destino : "/inbox");
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
