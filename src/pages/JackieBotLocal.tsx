import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { askJackieBotLocal } from "@/lib/jackieBotLocal";

type Turn = { role: "user" | "assistant"; content: string };

export default function JackieBotLocal() {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setStatus("");
    const r = await askJackieBotLocal(text, { history: turns });
    if (r.ok) {
      setTurns([...turns, { role: "user", content: text }, { role: "assistant", content: r.reply }]);
      setInput("");
      setStatus(`Answered by ${r.model} on LM Studio${r.personaFromCache ? " (saved persona)" : ""}.`);
    } else setStatus(r.error);
    setBusy(false);
  };

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Jackie Bot · LM Studio</h1>
      <p className="text-sm text-muted-foreground">Answers come from LM Studio on this PC (127.0.0.1:1234) using Jackie's persona.</p>
      <div className="space-y-3">
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "rounded-md bg-muted p-3" : "rounded-md border p-3"}>
            <p className="whitespace-pre-wrap text-sm">{t.content}</p>
          </div>
        ))}
      </div>
      <Textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Jackie…" rows={3} />
      <Button className="min-h-11" onClick={send} disabled={busy || !input.trim()}>{busy ? "Thinking…" : "Send"}</Button>
      {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
    </main>
  );
}
