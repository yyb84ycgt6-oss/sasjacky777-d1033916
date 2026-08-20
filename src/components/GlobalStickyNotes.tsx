import { useEffect, useState, useRef, useMemo } from "react";
import { DraggableToolbar } from "./DraggableToolbar";
import { Plus, Pin, X, StickyNote } from "lucide-react";

type Note = {
  id: string;
  text: string;
  color: string;
  x: number;
  y: number;
  pinned: boolean;
  pod?: string;
  agent?: string;
};

const STORAGE_KEY = "jackie.notes.v1";
const COLORS = ["#FFF8C6", "#CDE7FF", "#FFD6E7", "#D6FFEA", "#FFE3C6"];

export function GlobalStickyNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setNotes(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch {}
  }, [notes]);

  const addNote = () => {
    const id = Math.random().toString(36).slice(2);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    setNotes((n) => [
      ...n,
      { id, text: "New thought...", color, x: 120 + Math.random() * 200, y: 120 + Math.random() * 200, pinned: false },
    ]);
  };

  const updateText = (id: string, text: string) => {
    setNotes((n) => n.map((note) => (note.id === id ? { ...note, text } : note)));
  };

  const togglePin = (id: string) => {
    setNotes((n) => n.map((note) => (note.id === id ? { ...note, pinned: !note.pinned } : note)));
  };

  const removeNote = (id: string) => {
    setNotes((n) => n.filter((note) => note.id !== id));
  };

  const startDrag = (e: React.MouseEvent, id: string, note: Note) => {
    setDragId(id);
    offset.current = { x: e.clientX - note.x, y: e.clientY - note.y };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragId) return;
      setNotes((n) =>
        n.map((note) =>
          note.id === dragId ? { ...note, x: e.clientX - offset.current.x, y: e.clientY - offset.current.y } : note
        )
      );
    };
    const up = () => setDragId(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragId]);

  const pinnedCount = useMemo(() => notes.filter((n) => n.pinned).length, [notes]);

  return (
    <>
      <DraggableToolbar storageKey="jackie.notes.toolbar.v1">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOpen((v) => !v)}
            title="Toggle Notes"
            className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <StickyNote size={16} />
          </button>
          <button
            onClick={addNote}
            title="New Note"
            className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <Plus size={16} />
          </button>
          <span className="text-[10px] px-2 py-0.5 rounded bg-secondary text-muted-foreground">{pinnedCount} pinned</span>
        </div>
      </DraggableToolbar>

      {open && (
        <div className="fixed inset-0 pointer-events-none z-[60]">
          {notes.map((note) => (
            <div
              key={note.id}
              style={{ left: note.x, top: note.y, background: note.color }}
              className="pointer-events-auto absolute w-[220px] rounded-lg shadow-lg border border-border p-2"
            >
              <div
                className="flex items-center justify-between cursor-move mb-1"
                onMouseDown={(e) => startDrag(e, note.id, note)}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">thought</span>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => togglePin(note.id)} className="p-0.5 hover:text-foreground text-muted-foreground">
                    <Pin size={12} className={note.pinned ? "text-primary" : ""} />
                  </button>
                  <button onClick={() => removeNote(note.id)} className="p-0.5 hover:text-destructive text-muted-foreground">
                    <X size={12} />
                  </button>
                </div>
              </div>
              <textarea
                value={note.text}
                onChange={(e) => updateText(note.id, e.target.value)}
                className="w-full h-[100px] bg-transparent outline-none resize-none text-sm leading-relaxed"
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
