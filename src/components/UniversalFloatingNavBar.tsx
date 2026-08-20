import { DraggableToolbar } from "./DraggableToolbar";
import { useNavigate } from "react-router-dom";
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
} from "lucide-react";

export function UniversalFloatingNavBar() {
  const navigate = useNavigate();

  const buttons = [
    { icon: ArrowLeft, label: "Back", action: () => navigate(-1) },
    { icon: Home, label: "Home", action: () => navigate("/") },
    { icon: LayoutGrid, label: "Pods", action: () => navigate("/pods") },
    { icon: Bot, label: "Agents", action: () => navigate("/agent-lab") },
    { icon: FileText, label: "Files", action: () => navigate("/vault") },
    { icon: Clock, label: "Time", action: () => navigate("/control") },
    { icon: Bell, label: "Notify", action: () => {} },
    { icon: Settings, label: "Settings", action: () => navigate("/keys") },
  ];

  return (
    <DraggableToolbar storageKey="jackie.ufnb.pos.v1">
      <div className="flex items-center gap-0.5">
        {buttons.map(({ icon: Icon, label, action }) => (
          <button
            key={label}
            onClick={action}
            title={label}
            className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
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
      </div>
    </DraggableToolbar>
  );
}
