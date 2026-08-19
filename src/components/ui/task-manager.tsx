import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";

interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  createdAt: Date;
}

export function TaskManager() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [opacity, setOpacity] = useState(90);

  const addTask = () => {
    if (!newTaskTitle.trim()) return;
    
    const newTask: Task = {
      id: crypto.randomUUID(),
      title: newTaskTitle,
      description: newTaskDescription || undefined,
      completed: false,
      createdAt: new Date(),
    };

    setTasks([...tasks, newTask]);
    setNewTaskTitle("");
    setNewTaskDescription("");
  };

  const toggleTask = (id: string) => {
    setTasks(
      tasks.map((task) =>
        task.id === id ? { ...task, completed: !task.completed } : task
      )
    );
  };

  const deleteTask = (id: string) => {
    setTasks(tasks.filter((task) => task.id !== id));
  };

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <div className="flex items-center justify-between mb-4">
          <div>
            <CardTitle className="text-xl font-bold">Task Manager</CardTitle>
            <CardDescription>
              Organize your tasks with customizable transparency
            </CardDescription>
          </div>
          
          {/* Transparency Control */}
          <div className="flex items-center gap-4 p-3 bg-muted rounded-lg">
            <Label htmlFor="opacity-slider" className="text-sm font-medium">
              Opacity: {opacity}%
            </Label>
            
            <Slider
              value={[opacity]}
              onValueChange={([value]) => setOpacity(value)}
              min={0}
              max={90}
              step={1}
              className="w-32"
            />

            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={opacity}
                onChange={(e) => setOpacity(Math.min(90, Math.max(0, Number(e.target.value))))}
                min={0}
                max={90}
                className="w-16 h-8 text-sm"
              />
              <Badge variant="outline">0-90%</Badge>
            </div>

            <p className="text-xs text-muted-foreground max-w-[200px]">
              Set to 0% for fully transparent (not 100%)
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Add Task Form */}
        <form onSubmit={(e) => { e.preventDefault(); addTask(); }} className="flex gap-2">
          <Input
            placeholder="Enter task title..."
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder="Description (optional)"
            value={newTaskDescription}
            onChange={(e) => setNewTaskDescription(e.target.value)}
            className="flex-1"
          />
          <Button type="submit">Add Task</Button>
        </form>

        {/* Tasks List */}
        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
          {tasks.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No tasks yet. Add one above!
            </p>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                style={{ opacity: opacity / 100 }}
                className="flex items-center gap-3 p-3 rounded-lg border bg-background hover:bg-accent/50 transition-colors"
              >
                {/* Checkbox */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleTask(task.id)}
                  className={`h-6 w-6 flex items-center justify-center rounded-full border-2 ${
                    task.completed ? "bg-green-500 border-green-500 text-white" : ""
                  }`}
                >
                  {task.completed && (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </Button>

                {/* Task Info */}
                <div className="flex-1 min-w-0">
                  <p
                    style={{ opacity: opacity / 100 }}
                    className={`text-sm font-medium truncate ${
                      task.completed ? "line-through text-muted-foreground" : ""
                    }`}
                  >
                    {task.title}
                  </p>
                  {task.description && (
                    <p
                      style={{ opacity: opacity / 100 }}
                      className="text-xs text-muted-foreground truncate"
                    >
                      {task.description}
                    </p>
                  )}
                </div>

                {/* Delete Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteTask(task.id)}
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10 rounded-full"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center justify-between text-sm p-3 bg-muted rounded-lg">
          <span>Total: {tasks.length}</span>
          <span>Completed: {tasks.filter(t => t.completed).length}</span>
          <span>Pending: {tasks.filter(t => !t.completed).length}</span>
        </div>
      </CardContent>
    </Card>
  );
}
