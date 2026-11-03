import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Server-only Supabase client. Never import this module into client components. */
export function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Server Supabase environment is not configured.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Verify a real Supabase session and its database-assigned Super Admin role. */
export async function verifySuperAdminToken(token: string) {
  const db = createSupabaseAdmin();
  const { data: auth, error: authError } = await db.auth.getUser(token);

  if (authError || !auth.user) {
    return {
      ok: false as const,
      status: 401 as const,
      error: "Invalid session. Please sign in again.",
    };
  }

  const { data: roleRecord, error: roleError } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (roleError) {
    console.error("Super Admin role lookup failed:", roleError.message);
    return {
      ok: false as const,
      status: 500 as const,
      error: "Could not verify administrator permissions.",
    };
  }

  if (roleRecord?.role !== "super_admin") {
    return {
      ok: false as const,
      status: 403 as const,
      error: "Super Admin access required.",
    };
  }

  return { ok: true as const, db, user: auth.user };
}
