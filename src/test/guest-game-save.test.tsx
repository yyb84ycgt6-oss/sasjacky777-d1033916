import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameProvider, useGame } from '@/game/GameContext';

const cloud = vi.hoisted(() => ({
  upsert: vi.fn(),
  notify: vi.fn(),
  user: { id: 'signed-in-save-test', is_anonymous: false },
}));
vi.mock('sonner', () => ({ toast: { error: cloud.notify } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: cloud.user } } }) },
    from: () => ({
      upsert: cloud.upsert,
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  },
}));

function StartGuestGame() {
  const { startGame } = useGame();
  return <button onClick={() => startGame('Guest Verification Realm')}>Start</button>;
}

describe('game cloud saving', () => {
  beforeEach(() => {
    localStorage.clear();
    cloud.user = { id: 'signed-in-save-test', is_anonymous: false };
    cloud.notify.mockReset();
    cloud.upsert.mockReset().mockResolvedValue({ error: null });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('saves a full account realm under its own user with only deployed fields', async () => {
    const ui = render(<GameProvider><StartGuestGame /></GameProvider>);
    fireEvent.click(ui.getByText('Start'));
    await waitFor(() => expect(cloud.upsert).toHaveBeenCalled());
    const [row, options] = cloud.upsert.mock.calls[0];
    expect(Object.keys(row).sort()).toEqual(['game_state', 'updated_at', 'user_id']);
    expect(row.user_id).toBe('signed-in-save-test');
    expect(row.game_state.realmName).toBe('Guest Verification Realm');
    expect(options).toEqual({ onConflict: 'user_id' });
  });

  it('does not attempt cloud saves for anonymous guest sessions', async () => {
    cloud.user = { id: 'guest-save-test', is_anonymous: true };
    const ui = render(<GameProvider><StartGuestGame /></GameProvider>);
    fireEvent.click(ui.getByText('Start'));
    await new Promise((r) => setTimeout(r, 50));
    expect(cloud.upsert).not.toHaveBeenCalled();
  });

  it('reports a returned save refusal instead of silently treating it as success', async () => {
    cloud.upsert.mockResolvedValue({ error: { message: 'Save refused' } });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ui = render(<GameProvider><StartGuestGame /></GameProvider>);
    fireEvent.click(ui.getByText('Start'));
    await waitFor(() => expect(warning).toHaveBeenCalledWith('Cloud save failed:', 'Save refused'));
    expect(cloud.notify).toHaveBeenCalledWith('Cloud save failed. Your realm is still saved on this device.', { id: 'game-cloud-save' });
  });
});