import { DraggableToolbar } from "./DraggableToolbar";
import { useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import {
  ArrowLeft,
  Home,
  LayoutGrid,
  Bot,
  FileText,
  Clock,
  Bell,
  Settings,
  Search,
  Maximize2,
  Minimize2,
} from "lucide-react";

export function UniversalFloatingNavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [width, setWidth] = useState(320);
  const [expanded, setExpanded] = useState(false);
  const isRoot = location.pathname === "/" || location.pathname === "/index";
  const resizerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);

  // Persist width
  useEffect(() => {
    try {
      const raw = localStorage.getItem("jackie.ufnb.width.v1");
      if (raw) setWidth(parseInt(raw, 10));
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("jackie.ufnb.width.v1", String(width)); } catch {}
  }, [width]);

  // Resize handler
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(720, Math.max(280, e.clientX - 16));
      setWidth(newWidth);
    };
    const onUp = () => { isResizing.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const buttons = [
    { icon: ArrowLeft, label: "Back", action: () => navigate(-1), hidden: isRoot },
    { icon: Home, label: "Home", action: () => navigate("/"), active: isRoot },
    { icon: LayoutGrid, label: "Pods", action: () => navigate("/pods"), active: location.pathname.startsWith("/pods") },
    { icon: Bot, label: "Agents", action: () => navigate("/agent-lab"), active: location.pathname.startsWith("/agent-lab") || location.pathname.startsWith("/agent-compare") },
    { icon: FileText, label: "Files", action: () => navigate("/vault"), active: location.pathname.startsWith("/vault") },
    { icon: Clock, label: "Time", action: () => navigate("/control"), active: location.pathname.startsWith("/control") },
    { icon: Bell, label: "Notify", action: () => {}, active: false },
    { icon: Settings, label: "Settings", action: () => navigate("/keys"), active: location.pathname.startsWith("/keys") },
  ];

  return (
    <DraggableToolbar storageKey="jackie.ufnb.pos.v1">
      <div
        className="rounded-full bg-popover/95 backdrop-blur-md border border-border shadow-lg px-2 py-1.5 flex items-center gap-0.5"
        style={{ width, minWidth: 280, maxWidth: 720 }}
      >
        <div className="flex items-center gap-0.5 flex-1 overflow-hidden">
          {buttons.filter(b => !b.hidden).map(({ icon: Icon, label, action, active }) => (
            <button
              key={label}
              onClick={action}
              title={label}
              aria-label={label}
              className={`p-1.5 rounded-full transition-colors ${active ? "text-primary bg-secondary" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
            >
              <Icon size={16} />
            </button>
          ))}
          <button
            title="Quick Search ⌘K"
            className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            onClick={() => console.log("Quick Search")}
          >
            <Search size={16} />
          </button>
          <button
            onClick={() => setExpanded(v => !v)}
            title={expanded ? "Collapse" : "Expand widgets"}
            className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
        <div
          ref={resizerRef}
          onMouseDown={() => { isResizing.current = true; }}
          className="w-3 h-6 cursor-ew-resize rounded-r-full hover:bg-secondary/60 flex items-center justify-center"
          title="Resize"
        >
          <div className="w-px h-4 bg-border" />
        </div>
      </div>
      {expanded && (
        <div className="mt-2 rounded-xl bg-popover/95 backdrop-blur-md border border-border shadow-lg p-3 grid grid-cols-2 gap-2">
          <div className="col-span-2 text-[10px] uppercase tracking-wide text-muted-foreground">Mini-map • Agent Pulse • Task Queue • System Health</div>
          <div className="h-16 rounded-lg bg-secondary/50 flex items-center justify-center text-[10px] text-muted-foreground">Pod Mini-Map</div>
          <div className="h-16 rounded-lg bg-secondary/50 flex items-center justify-center text-[10px] text-muted-foreground">Agent Pulse</div>
          <div className="h-16 rounded-lg bg-secondary/50 flex items-center justify-center text-[10px] text-muted-foreground">Task Queue</div>
          <div className="h-16 rounded-lg bg-secondary/50 flex items-center justify-center text-[10px] text-muted-foreground">System Health</div>
        </div>
      )}
    </DraggableToolbar>
  );
}
