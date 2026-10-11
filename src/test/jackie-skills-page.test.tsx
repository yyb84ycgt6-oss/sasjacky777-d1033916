import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The page where the person decides what their agents may use: that an
 * agent's proposal is shown with where it came from and approved only by a
 * click here, that a tool that cannot run is refused with the reason before
 * it is saved, and that a connection's grants — its key, writes, app data —
 * are each the person's own click, shown in words.
 */

const data = vi.hoisted(() => ({
  loadSkills: vi.fn(),
  loadTools: vi.fn(),
  loadActivity: vi.fn(),
  saveSkill: vi.fn(),
  saveTool: vi.fn(),
  setStatus: vi.fn(),
  remove: vi.fn(),
  runToolNow: vi.fn(),
  loadConnections: vi.fn(),
  saveConnection: vi.fn(),
  setAgentsMayWrite: vi.fn(),
  setAcceptsAppData: vi.fn(),
  loadSecretStatus: vi.fn(),
  setSecret: vi.fn(),
  clearSecret: vi.fn(),
  runOperationNow: vi.fn(),
}));
vi.mock("@/lib/jackie-skills", () => data);
vi.mock("@/integrations/supabase/client", () => ({ supabase: { marker: "client" } }));

import JackieSkills from "@/pages/JackieSkills";

const proposal = {
  id: "s1", name: "bug_reports", title: "Bug reports", description: "When filing a bug.", body: "Steps, expected, actual.",
  status: "proposed", proposed_by: "agent:mcp", created_at: "", updated_at: "",
};
const toolProposal = {
  id: "t1", name: "clear_done", description: "Delete finished tasks.", params: [], status: "proposed", proposed_by: "agent:agent-lab",
  steps: [{ action: "delete_task", args: { id: "x" } }], created_at: "", updated_at: "",
};

const ops = [
  { name: "search", description: "Search issues.", method: "GET", path: "/search/issues", params: [{ name: "q", in: "query", type: "string", required: true }] },
  { name: "comment", description: "Comment on an issue.", method: "POST", path: "/issues/{n}/comments", params: [{ name: "n", in: "path", type: "number", required: true }] },
];
const connectionProposal = {
  id: "c1", name: "tracker", title: "Issue tracker", description: "My issues.", base_url: "https://api.tracker.example.com",
  auth_type: "bearer", auth_name: null, operations: ops, agents_may_write: false, status: "proposed", proposed_by: "agent:mcp",
  created_at: "", updated_at: "",
};
const activeConnection = { ...connectionProposal, id: "c2", name: "github", title: "GitHub", base_url: "https://api.github.com", status: "active", proposed_by: null };

function renderPage() {
  return render(<MemoryRouter><JackieSkills /></MemoryRouter>);
}

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset();
  data.loadSkills.mockResolvedValue({ ok: true, data: [proposal] });
  data.loadTools.mockResolvedValue({ ok: true, data: [toolProposal] });
  data.loadActivity.mockResolvedValue({
    ok: true,
    data: [{ id: "a1", ts: "2026-10-11T10:00:00Z", action: "tool.run", actor: "agent:mcp", details: { name: "start_review", failed_step: 2 }, result: "error" }],
  });
  data.loadConnections.mockResolvedValue({ ok: true, data: [connectionProposal, activeConnection] });
  data.loadSecretStatus.mockResolvedValue({ ok: true, data: { secrets: [] } });
  for (const fn of [data.saveSkill, data.saveTool, data.setStatus, data.remove, data.setAgentsMayWrite, data.setAcceptsAppData]) {
    fn.mockResolvedValue({ ok: true, data: null });
  }
});

const openTab = async (name: RegExp) => {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

describe("the skills page", () => {
  it("shows what agents proposed, and who proposed it, waiting for the person", async () => {
    renderPage();
    await openTab(/Waiting for you \(3\)/);
    expect(await screen.findByText("Bug reports")).toBeTruthy();
    expect(screen.getAllByText(/proposed by an external agent \(MCP\)/)).toHaveLength(2);
    expect(screen.getByText(/proposed by an Agent Lab operator/)).toBeTruthy();
    expect(screen.getByText(/Deletes things/)).toBeTruthy();
  });

  it("switches a proposal on only when the person approves it", async () => {
    renderPage();
    await openTab(/Waiting for you/);
    const approve = (await screen.findAllByRole("button", { name: /Approve/ }))[0];
    fireEvent.click(approve);
    await waitFor(() => expect(data.setStatus).toHaveBeenCalledWith("jackie_skills", "s1", "active"));
  });

  it("rejecting a proposal removes it", async () => {
    renderPage();
    await openTab(/Waiting for you/);
    fireEvent.click((await screen.findAllByRole("button", { name: /Reject/ }))[1]);
    await waitFor(() => expect(data.remove).toHaveBeenCalledWith("jackie_custom_tools", "t1"));
  });

  it("names the step whose arguments are not valid JSON, and will not save the tool", async () => {
    renderPage();
    await openTab(/^Tools/);
    fireEvent.click(await screen.findByRole("button", { name: /New tool/ }));
    fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "my_tool" } });
    fireEvent.change(screen.getByLabelText("What it does"), { target: { value: "Does a thing." } });
    fireEvent.change(screen.getByLabelText("Step 1 arguments"), { target: { value: "{not json" } });
    expect(screen.getByText("Step 1's arguments are not valid JSON.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a placeholder that names no parameter before it is saved", async () => {
    renderPage();
    await openTab(/^Tools/);
    fireEvent.click(await screen.findByRole("button", { name: /New tool/ }));
    fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "my_tool" } });
    fireEvent.change(screen.getByLabelText("What it does"), { target: { value: "Does a thing." } });
    fireEvent.change(screen.getByLabelText("Step 1 arguments"), { target: { value: '{"status": "{{state}}"}' } });
    expect(screen.getByText(/refers to \{\{state\}\}, which is not one of the tool's parameters/)).toBeTruthy();
  });

  it("shows what agents did, including a run that failed and where", async () => {
    renderPage();
    await openTab(/What agents did/);
    expect(await screen.findByText("ran tool")).toBeTruthy();
    expect(screen.getByText("failed at step 2")).toBeTruthy();
  });

  it("says the tables are missing in words, not an error code", async () => {
    data.loadSkills.mockResolvedValue({ ok: false, error: "The skills tables are not in the database yet. Run `supabase db push`, then reload." });
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/supabase db push/)).toBeTruthy();
  });

  it("shows a proposed connection's host and every operation, writes marked, before it can be approved", async () => {
    renderPage();
    await openTab(/Waiting for you/);
    expect(await screen.findByText("https://api.tracker.example.com")).toBeTruthy();
    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.getByText(/Writes, app data and the key stay\s+off until you turn them on/)).toBeTruthy();
    fireEvent.click((await screen.findAllByRole("button", { name: /Approve/ }))[2]);
    await waitFor(() => expect(data.setStatus).toHaveBeenCalledWith("jackie_connections", "c1", "active"));
  });

  it("says when it does not know which keys are stored, rather than claiming none are", async () => {
    data.loadSecretStatus.mockResolvedValue({ ok: false, error: "CONNECTIONS_SECRET_KEY is not set" });
    renderPage();
    await openTab(/^Connections/);
    expect(await screen.findByText(/Could not check which keys are stored/)).toBeTruthy();
    expect(screen.getByText("key status unknown")).toBeTruthy();
    expect(screen.queryByText(/no key yet/)).toBeNull();
  });

  it("lets agents write to a connection only when the person turns it on", async () => {
    renderPage();
    await openTab(/^Connections/);
    expect(await screen.findByText("Agents may only read")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Agents may write to github" }));
    await waitFor(() => expect(data.setAgentsMayWrite).toHaveBeenCalledWith("c2", true));
  });

  it("refuses a connection to a private address before it is saved", async () => {
    renderPage();
    await openTab(/^Connections/);
    fireEvent.click(await screen.findByRole("button", { name: /New connection/ }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "metadata" } });
    fireEvent.change(screen.getByLabelText("Connection title"), { target: { value: "Metadata" } });
    fireEvent.change(screen.getByLabelText("What the service is"), { target: { value: "Cloud metadata." } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://169.254.169.254" } });
    expect(await screen.findByText(/IP address|DNS name|hostname/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(data.saveConnection).not.toHaveBeenCalled();
  });
});
