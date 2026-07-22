import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json();
    const router_id = String(body?.router_id ?? '');
    const secret = String(body?.secret ?? '');
    const job_id = String(body?.job_id ?? '');
    const result = body?.result != null ? String(body.result) : null;
    const error = body?.error != null ? String(body.error) : null;
    if (!router_id || !secret || !job_id) return new Response(JSON.stringify({ error: 'router_id + secret + job_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: router } = await admin.from('mesh_routers').select('id,secret_hash,status').eq('id', router_id).maybeSingle();
    const secret_hash = await sha256(secret);
    if (!router || router.secret_hash !== secret_hash || router.status !== 'active') {
      return new Response(JSON.stringify({ error: 'invalid credentials' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { error: updErr } = await admin.from('mesh_jobs').update({
      status: error ? 'failed' : 'done',
      result,
      error,
      finished_at: new Date().toISOString(),
    }).eq('id', job_id).eq('router_id', router.id);

    if (updErr) return new Response(JSON.stringify({ error: updErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    await admin.from('mesh_routers').update({ last_seen_at: new Date().toISOString() }).eq('id', router.id);

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
