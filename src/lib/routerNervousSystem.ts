/**
 * Jackie Sovereign OS – Router Nervous System
 * Event bus for navigation, UFNB, Filing, Sticky Notes, Agents, Pods
 * 
 * Myth: Router is the nervous system, branching like roots.
 * Every navigation action is an impulse traveling through the OS.
 */

type EventName = 
  | 'nav:back'
  | 'nav:home'
  | 'nav:pods'
  | 'nav:agents'
  | 'nav:files'
  | 'nav:time'
  | 'nav:notif'
  | 'nav:settings'
  | 'nav:notes:new'
  | 'nav:notes:open'
  | 'nav:notes:save'
  | 'ufnb:drag'
  | 'ufnb:dock'
  | 'ufnb:resize'
  | 'notes:create'
  | 'notes:update'
  | 'notes:pin'
  | 'notes:link:pod'
  | 'notes:link:agent'
  | 'filing:write'
  | 'filing:read'
  | 'filing:archive'
  | 'agent:activate'
  | 'agent:deactivate'
  | 'pod:enter'
  | 'pod:leave'
  | 'nav:custom'
  | 'pod:fold'
  | 'pod:slice';

type EventPayload = Record<string, any>;

type Listener = (payload: EventPayload, event: EventName) => void;

class RouterNervousSystem {
  private listeners = new Map<EventName, Set<Listener>>();
  private history: Array<{event: EventName, payload: EventPayload, ts: number}> = [];

  on(event: EventName, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return () => this.off(event, listener);
  }

  off(event: EventName, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: EventName, payload: EventPayload = {}) {
    const ts = Date.now();
    this.history.push({ event, payload, ts });
    if (this.history.length > 1000) this.history.shift();
    
    // Haptic feedback hook
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate(10); } catch {}
    }

    this.listeners.get(event)?.forEach(l => {
      try { l(payload, event); } catch {}
    });

    // Global logging
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Jackie.NS] ${event}`, payload);
    }
  }

  getHistory(filter?: EventName) {
    return filter 
      ? this.history.filter(h => h.event === filter)
      : [...this.history];
  }

  // Sovereign OS helpers
  navigate = (path: string) => this.emit('nav:custom', { path });
  createNote = (note: any) => this.emit('notes:create', { note });
  linkNoteToPod = (noteId: string, podId: string) => this.emit('notes:link:pod', { noteId, podId });
  linkNoteToAgent = (noteId: string, agentId: string) => this.emit('notes:link:agent', { noteId, agentId });
}

export const routerNS = new RouterNervousSystem();

/**
 * Filing System Bridge – every note/pod/agent is a file
 */
export const FilingSystem = {
  write: (entityType: 'note' | 'pod' | 'agent' | 'task', id: string, data: any) => {
    routerNS.emit('filing:write', { entityType, id, data, ts: Date.now() });
    try {
      const key = `jackie.filing.${entityType}.${id}`;
      localStorage.setItem(key, JSON.stringify(data));
    } catch {}
  },
  read: (entityType: string, id: string) => {
    try {
      const raw = localStorage.getItem(`jackie.filing.${entityType}.${id}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  archive: (entityType: string, id: string) => {
    routerNS.emit('filing:archive', { entityType, id });
  }
};

export default routerNS;
