import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual handler with fake services: foreign references must fail
// before inference, even though privileged writes would bypass row policies.
function loadHandler(path: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(path, 'utf8').replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, '');
  let handler: (req: Request) => Promise<Response> = async () => new Response('', { status: 500 });
  const serve = (fn: typeof handler) => { handler = fn; };
  const deno = { serve, env: { get: () => 'configured' } };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  new Function('Deno', 'serve', ...Object.keys(dependencies), js)(deno, serve, ...Object.values(dependencies));
  return (body: object) => handler(new Request('http://localhost/test', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

describe('privileged handlers preserve account boundaries', () => {
  for (const field of ['pod_id', 'router_id']) {
    it(`refuses another account's ${field} before embedding or inserting`, async () => {
      const quota = vi.fn();
      const network = vi.fn();
      const filters: Array<[string, string]> = [];
      const builder = { select: () => builder, eq: (key: string, value: string) => { filters.push([key, value]); return builder; }, maybeSingle: async () => ({ data: null, error: null }) };
      const run = loadHandler('supabase/functions/pod-fold/index.ts', {
        createClient: () => ({ auth: {}, from: () => builder }),
        verifyAccessToken: async () => ({ data: { claims: { sub: 'guest-one' } }, error: null }),
        consumeQuota: quota, fetch: network,
      });
      const result = await run({ text: 'Test fold', [field]: 'foreign-record' });
      expect(result.status).toBe(403);
      expect(filters).toContainEqual(['user_id', 'guest-one']);
      expect(quota).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    });
  }

  for (const action of ['call', 'set_secret', 'clear_secret', 'secrets']) {
    it(`refuses guest ${action} before reading any saved connection or credential`, async () => {
      const read = vi.fn();
      const network = vi.fn();
      const run = loadHandler('supabase/functions/jackie-connect/index.ts', {
        requireOwnerUser: async () => ({ userId: 'guest-one' }),
        adminClient: () => ({ auth: { admin: { getUserById: async () => ({ data: { user: { is_anonymous: true } }, error: null }) } }, from: read }),
        json: (body: object, status = 200) => new Response(JSON.stringify(body), { status }),
        fetch: network,
      });
      expect((await run({ action })).status).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    });
  }

  it('refuses a signed-in non-owner before any connection is read or any request leaves', async () => {
    const read = vi.fn();
    const network = vi.fn();
    const run = loadHandler('supabase/functions/jackie-connect/index.ts', {
      requireOwnerUser: async () => new Response(JSON.stringify({ code: 'OWNER_ONLY' }), { status: 403 }),
      adminClient: () => ({ from: read }),
      json: (body: object, status = 200) => new Response(JSON.stringify(body), { status }),
      fetch: network,
    });
    expect((await run({ action: 'call', connection: 'x', operation: 'y' })).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
