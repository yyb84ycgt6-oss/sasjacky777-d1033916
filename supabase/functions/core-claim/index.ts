// core-claim: grants the caller the 'owner' role, but only if their own
// verified email is already on the jackie_core_access allowlist.
//
// This used to be a database routine callable over the API by any signed-in
// client. The privileged write now happens here instead: the email comes from a
// verified JWT (never from the request body), the allowlist is read with the
// service role, and no caller-supplied identity is trusted at any point.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Not signed in" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await asUser.auth.getUser();
  const user = userData?.user;
  if (!user?.email) return json({ error: "Invalid session" }, 401);

  const email = user.email.toLowerCase();
  const admin = createClient(url, service);

  const { data: allowed } = await admin
    .from("jackie_core_access")
    .select("id")
    .ilike("email", email)
    .maybeSingle();

  if (!allowed) return json({ granted: false, reason: "not_allowlisted" }, 403);

  const { error } = await admin
    .from("user_roles")
    .upsert({ user_id: user.id, role: "owner" }, { onConflict: "user_id,role" });

  if (error) return json({ error: error.message }, 500);
  return json({ granted: true });
});
