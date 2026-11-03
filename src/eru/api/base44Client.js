/**
 * Compatibility path for Eru's backend client.
 *
 * 196 Eru files import `base44` from this path. Renaming all of them is a
 * mechanical change for a later step; until then this file only wires the
 * offline client in `./backend.js` to the owner's Supabase session and hands
 * it out under the old name. It imports no SDK and reads no environment
 * variable, so nothing can turn a remote backend on from here.
 */
import { supabase } from '@/integrations/supabase/client';
import { createOfflineBackend } from './backend';

// The signed-in person, in the shape Eru screens expect, from the session the
// owner's own Supabase project already holds.
async function currentUser() {
  const { data } = await supabase.auth.getUser();
  const u = data?.user;
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    full_name: u.user_metadata?.full_name || u.email?.split('@')[0] || 'Operator',
    role: u.user_metadata?.role || 'user',
    isAdmin: u.user_metadata?.role === 'admin',
    avatar_url: u.user_metadata?.avatar_url,
  };
}

export const base44 = createOfflineBackend({
  getUser: currentUser,
  goToSignIn: () => {
    window.location.href = '/auth';
  },
  signOut: async () => {
    await supabase.auth.signOut();
    window.location.href = '/auth';
  },
});
