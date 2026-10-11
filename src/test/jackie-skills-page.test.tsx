import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The page where the person decides what their agents may use: that an
 * agent's proposal is shown with where it came from and approved only by a
 * click here, and that a tool that cannot run is refused with the reason
 * before it is saved.
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
  for (const fn of [data.saveSkill, data.saveTool, data.setStatus, data.remove]) fn.mockResolvedValue({ ok: true, data: null });
});

const openTab = async (name: RegExp) => {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

describe("the skills page", () => {
  it("shows what agents proposed, and who proposed it, waiting for the person", async () => {
    renderPage();
    await openTab(/Waiting for you \(2\)/);
    expect(await screen.findByText("Bug reports")).toBeTruthy();
    expect(screen.getByText(/proposed by an external agent \(MCP\)/)).toBeTruthy();
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
});
