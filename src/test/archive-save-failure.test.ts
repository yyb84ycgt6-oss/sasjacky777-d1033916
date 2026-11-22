import { describe, expect, it, vi } from 'vitest';
import { importArchive } from '@/lib/jackie-archive';

vi.mock('@/lib/jackie-db', () => ({
  createConversation: async () => ({ id: 'new-guest-conversation' }),
  listConversations: vi.fn(), getMessages: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: { id: 'guest-one', is_anonymous: true } } }) },
  from: () => ({ insert: async () => ({ error: { message: 'Storage refused' } }) }),
} }));

describe('archive importing', () => {
  it('refuses to report a successful import when archived messages were not saved', async () => {
    const file = { text: async () => JSON.stringify({ source: 'jackie', conversations: [{ title: 'Test', messages: [{ role: 'user', content: 'Test message' }] }] }) } as File;
    await expect(importArchive(file)).rejects.toThrow('messages for "Test" were not saved');
  });
});