import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

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
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await req.json();
    const query = String(body?.query ?? '').slice(0, 5000);
    const limit = Math.min(50, Math.max(1, Number(body?.limit ?? 10)));
    if (!query) return new Response(JSON.stringify({ error: 'query required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const embRes = await fetch('https://ai.gateway.lovable.dev/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Lovable-API-Key': lovableKey },
      body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: query, dimensions: 768 }),
    });
    if (!embRes.ok) return new Response(JSON.stringify({ error: await embRes.text() }), { status: embRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const embJson = await embRes.json();
    const q = embJson?.data?.[0]?.embedding;

    const admin = createClient(url, service);
    // Manual cosine similarity via SQL parameter.
    const { data, error } = await admin.rpc('match_pod_folds' as any, {
      query_embedding: q,
      match_user: userData.user.id,
      match_count: limit,
    });
    if (error) {
      // Fallback: direct select (no rpc yet). Return raw folds.
      const { data: folds } = await admin.from('pod_folds')
        .select('id,pod_id,router_id,capability,source_ref,source_hash,color,glyph,created_at')
        .eq('user_id', userData.user.id)
        .order('created_at', { ascending: false })
        .limit(limit);
      return new Response(JSON.stringify({ hits: folds ?? [], note: 'similarity RPC missing; returning recent folds' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ hits: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
