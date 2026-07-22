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
    const auth = req.headers.get('Authorization');
    if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableKey = Deno.env.get('LOVABLE_API_KEY')!;

    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await req.json();
    const text = String(body?.text ?? '').slice(0, 30000);
    const pod_id = body?.pod_id ? String(body.pod_id) : null;
    const router_id = body?.router_id ? String(body.router_id) : null;
    const capability = String(body?.capability ?? 'seed:generic').slice(0, 60);
    const source_ref = body?.source_ref ? String(body.source_ref).slice(0, 200) : null;
    const color = body?.color ? String(body.color).slice(0, 20) : null;
    const glyph = body?.glyph ? String(body.glyph).slice(0, 6) : null;
    if (!text) return new Response(JSON.stringify({ error: 'text required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const embRes = await fetch('https://ai.gateway.lovable.dev/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Lovable-API-Key': lovableKey },
      body: JSON.stringify({
        model: 'openai/text-embedding-3-small',
        input: text,
        dimensions: 768,
      }),
    });
    if (!embRes.ok) {
      const errText = await embRes.text();
      return new Response(JSON.stringify({ error: `embed failed: ${errText}` }), { status: embRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const embJson = await embRes.json();
    const vector = embJson?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) return new Response(JSON.stringify({ error: 'no embedding' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const source_hash = await sha256(text);
    const admin = createClient(url, service);
    const { data, error } = await admin.from('pod_folds').insert({
      user_id: userData.user.id,
      pod_id, router_id, capability, source_ref, source_hash, color, glyph,
      embedding: vector as any,
    }).select('id,source_hash').single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({ fold_id: data.id, hash: data.source_hash, dims: vector.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
