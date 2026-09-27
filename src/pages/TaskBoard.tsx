import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ArrowLeft, Plus, RefreshCw, SquareKanban } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TaskCard } from "@/components/tasks/TaskCard";
import { TaskDialog, type TaskDraft } from "@/components/tasks/TaskDialog";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { TASK_STATUSES, createTask, deleteTask, listTasks, updateTask, type TaskStatus } from "@/lib/appActions";
import {
  BOARD_COLUMNS,
  BOARD_LIMIT,
  arrangeBoard,
  localDayKey,
  withSaved,
  withStatus,
  type BoardTask,
} from "@/lib/taskBoard";

const COLUMN_EDGE: Record<TaskStatus, string> = {
  todo: "border-muted-foreground/30",
  in_progress: "border-primary/50",
  blocked: "border-destructive/50",
  done: "border-accent/50",
};

/**
 * The task board — the screen the `create_task` tool has always told agents
 * their tasks "appear on", which until now did not exist. Tasks could be made
 * from the chat (`/task`), from Hermes or DeepSeek over MCP, or by an Agent Lab
 * operator, and the only way to see them all was to ask.
 *
 * Ported from jackie-core-keeper's TaskBoard, and changed on the way in: it
 * reads and writes through `appActions.ts` rather than its own table helpers,
 * so the board and every agent obey one set of rules; it has the `blocked`
 * column this database has and the donor did not; and a write the database
 * refuses puts the card back and says why, rather than leaving it where it was
 * dropped (CLAUDE.md rule 8).
 */
const TaskBoard = () => {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<{ task: BoardTask | null; status: TaskStatus } | null>(null);
  const [today, setToday] = useState(() => localDayKey());

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const r = await listTasks(supabase, userId, { limit: BOARD_LIMIT });
    setLoading(false);
    setToday(localDayKey());
    if (!r.ok) {
      setLoadError(r.error);
      return;
    }
    setTasks(r.data as BoardTask[]);
    setLoadError(null);
    setLoaded(true);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Agents change this board while it is open in another tab — Hermes over MCP,
  // an operator in the Agent Lab, the chat's /task. Coming back to the tab
  // re-reads, so what is on screen is what is in the database.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const board = useMemo(() => arrangeBoard(tasks), [tasks]);

  const markBusy = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const move = async (task: BoardTask, status: TaskStatus) => {
    if (!userId || task.status === status) return;
    setTasks((ts) => withStatus(ts, task.id, status));
    markBusy(task.id, true);
    const r = await updateTask(supabase, userId, { id: task.id, status });
    markBusy(task.id, false);
    if (!r.ok) {
      // Only this card goes back. Restoring the whole array would also undo
      // any other move that landed while this one was in flight.
      setTasks((ts) => ts.map((t) => (t.id === task.id ? task : t)));
      toast.error(`Couldn't move “${task.title}”`, { description: r.error });
      return;
    }
    setTasks((ts) => withSaved(ts, r.data as BoardTask));
  };

  const onDragEnd = (result: DropResult) => {
    const to = result.destination?.droppableId as TaskStatus | undefined;
    if (!to || to === result.source.droppableId || !TASK_STATUSES.includes(to)) return;
    const task = tasks.find((t) => t.id === result.draggableId);
    if (task) void move(task, to);
  };

  const save = async (draft: TaskDraft): Promise<string | null> => {
    if (!userId || !dialog) return "You are signed out. Sign in again and retry.";
    const r = dialog.task
      ? await updateTask(supabase, userId, {
          id: dialog.task.id,
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          due_date: draft.due,
        })
      : await createTask(supabase, userId, {
          title: draft.title,
          description: draft.description || undefined,
          status: draft.status,
          priority: draft.priority,
          due_date: draft.due || undefined,
        });
    if (!r.ok) return r.error;
    if (!r.data) return "The task was not saved: the database returned nothing. Refresh and check before retrying.";
    setTasks((ts) => withSaved(ts, r.data as BoardTask));
    setDialog(null);
    return null;
  };

  const remove = async (): Promise<string | null> => {
    const task = dialog?.task;
    if (!userId || !task) return "Nothing to delete.";
    const r = await deleteTask(supabase, userId, { id: task.id });
    if (!r.ok) return r.error;
    setTasks((ts) => ts.filter((t) => t.id !== task.id));
    setDialog(null);
    return null;
  };

  const openCount = tasks.length - board.done.length;

  return (
    <div className="min-h-screen w-full bg-background flex flex-col">
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-sidebar sticky top-0 z-10">
        <Link
          to="/"
          className="flex items-center gap-1.5 px-2 py-1 rounded-sm font-mono text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <ArrowLeft size={14} />
          Jackie
        </Link>
        <div className="flex items-center gap-2">
          <SquareKanban size={14} className="text-primary" />
          <h1 className="font-mono text-xs uppercase tracking-widest text-foreground">Task Board</h1>
          {loaded && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {openCount} open · {board.done.length} done
            </span>
          )}
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="font-mono text-[10px] uppercase tracking-widest"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={12} className={cn("mr-1", loading && "animate-spin")} />
          Refresh
        </Button>
        <Button
          size="sm"
          className="font-mono text-[10px] uppercase tracking-widest"
          onClick={() => setDialog({ task: null, status: "todo" })}
          disabled={!loaded}
        >
          <Plus size={12} className="mr-1" />
          New task
        </Button>
      </header>

      <main className="flex-1 p-4">
        {!loaded && loadError ? (
          <div role="alert" className="max-w-md mx-auto mt-16 text-center space-y-3">
            <p className="font-mono text-sm text-destructive">Couldn't load your tasks.</p>
            <p className="font-mono text-xs text-muted-foreground">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !loaded ? (
          <p className="font-mono text-xs text-muted-foreground text-center mt-16">Loading tasks…</p>
        ) : (
          <div className="max-w-7xl mx-auto space-y-3">
            {loadError && (
              <p role="alert" className="font-mono text-xs text-destructive">
                Couldn't refresh — showing what was loaded before. {loadError}
              </p>
            )}
            {tasks.length >= BOARD_LIMIT && (
              <p className="font-mono text-xs text-muted-foreground">
                Showing your newest {BOARD_LIMIT} tasks. Older ones exist but are not on this board.
              </p>
            )}
            {tasks.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">
                No tasks yet. Add one here, type <code>/task</code> followed by a title in the chat, or ask an agent to
                make one — they all land on this board.
              </p>
            )}

            <DragDropContext onDragEnd={onDragEnd}>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {BOARD_COLUMNS.map((col) => (
                  <section
                    key={col.status}
                    aria-label={col.label}
                    className={cn("border-t-2 bg-secondary/10 rounded-sm p-3 flex flex-col", COLUMN_EDGE[col.status])}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground" title={col.hint}>
                        {col.label} ({board[col.status].length})
                      </h2>
                      <button
                        type="button"
                        aria-label={`Add a task to ${col.label}`}
                        onClick={() => setDialog({ task: null, status: col.status })}
                        className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded-sm"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <Droppable droppableId={col.status}>
                      {(drop, snapshot) => (
                        <div
                          ref={drop.innerRef}
                          {...drop.droppableProps}
                          className={cn(
                            "flex-1 min-h-[8rem] space-y-2 rounded-sm transition-colors",
                            snapshot.isDraggingOver && "bg-secondary/30",
                          )}
                        >
                          {board[col.status].map((task, index) => (
                            <Draggable key={task.id} draggableId={task.id} index={index} isDragDisabled={busy.has(task.id)}>
                              {(drag) => (
                                <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}>
                                  <TaskCard
                                    task={task}
                                    today={today}
                                    busy={busy.has(task.id)}
                                    onOpen={() => setDialog({ task, status: task.status })}
                                    onMove={(status) => void move(task, status)}
                                  />
                                </div>
                              )}
                            </Draggable>
                          ))}
                          {drop.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </section>
                ))}
              </div>
            </DragDropContext>
          </div>
        )}
      </main>

      <TaskDialog
        open={dialog !== null}
        task={dialog?.task ?? null}
        initialStatus={dialog?.status ?? "todo"}
        onClose={() => setDialog(null)}
        onSave={save}
        onDelete={dialog?.task ? remove : undefined}
      />
    </div>
  );
};

export default TaskBoard;
