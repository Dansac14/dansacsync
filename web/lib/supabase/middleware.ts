// =============================================================================
// Renovacion de sesion en el middleware
// =============================================================================
// Los Server Components no pueden escribir cookies, asi que si la renovacion
// del token no se hace aqui, la sesion caduca y el operador es expulsado a
// media conversacion.
// =============================================================================

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth"];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser y no getSession: getUser valida el token contra el servidor de
  // autenticacion. getSession se conforma con lo que haya en la cookie, que en
  // el servidor no es de fiar.
  //
  // La llamada va por red, asi que puede fallar. Sin este try, una caida
  // momentanea del servicio de autenticacion devolveria un error 500 en TODAS
  // las rutas, incluida la de ingreso: nadie podria ni volver a entrar. Un
  // fallo se trata como "no hay sesion", que es la interpretacion segura.
  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    user = null;
  }

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Se recuerda a donde iba para devolverlo ahi despues de entrar.
    url.searchParams.set("destino", path);
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
