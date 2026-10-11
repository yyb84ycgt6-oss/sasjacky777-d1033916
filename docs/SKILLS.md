# Skills and custom tools

`/skills` is where you teach the agents that drive Jackie: Hermes Agent and DeepSeek
Harness over MCP, and the Agent Lab's operators. There are two kinds of thing to
teach them, and they can propose both themselves.

| | What it is | How an agent uses it |
| --- | --- | --- |
| **Skill** | Named instructions for a kind of task ("how I like a weekly review run"). A title, one line saying when it applies, and up to 8,000 characters of Markdown. | `list_skills` shows each skill's one line. `get_skill` loads the instructions when a task fits. |
| **Custom tool** | A named recipe of up to 8 steps, each one of the actions agents already have (`create_task`, `remember_fact`, `list_tasks`, …), with parameters. | `list_custom_tools` shows signatures. `run_custom_tool` runs one. |

A custom tool **adds no capability**. Each step goes through the same action an agent
could call directly, under the same row-level security. There is no code, no network
call and no model call in a tool, so a tool can never do more than the agent running
it could already do one step at a time.

## Agents propose, you decide

`propose_skill` and `propose_tool` save what an agent wrote as a **proposal**, switched
off. It appears under **Waiting for you** on `/skills`, with where it came from. Nothing
an agent proposes is listed to any agent, or runnable, until you approve it.

This is enforced in the database, not only in the tools. An agent harness holds a real
access token and is one HTTP call away from the API. Tokens the MCP server accepts carry
an OAuth `client_id`; the app's own session does not. A trigger on both tables
(`private.agent_proposals_only`) lets a write carrying a `client_id` do one thing:
insert a row with status `proposed`. It cannot activate, edit, archive or delete
anything, including its own proposal. `scripts/db-authz-test.sh` proves each of those
refusals, for both forms in which PostgREST publishes claims.

A runaway agent cannot bury your list either: 20 pending proposals of each kind is the
cap, and 200 skills or tools per account.

## Writing a tool

Steps are JSON. A step's arguments may use:

- `{{topic}}` for a parameter of the tool;
- `{{steps.0.id}}` for a field of an earlier step's result. Step 1 is `steps.0`.

A placeholder that is the whole value keeps its type (a number stays a number). One
inside other text is written in as text. An optional parameter that was left out drops
its argument rather than sending it empty. Every placeholder is checked when the tool is
saved: a parameter that does not exist, or a step that refers to a later step, is refused
with the reason.

```json
[
  {"action": "create_task", "args": {"title": "Review {{topic}}", "priority": "high"}},
  {"action": "update_task", "args": {"id": "{{steps.0.id}}", "status": "in_progress"}}
]
```

A run stops at the first failing step. The error names the step and lists the steps that
already ran, so an agent does not retry from the top and do them twice. A tool with a
deleting step (`delete_task`, `forget_fact`) is refused for an Agent Lab operator whose
**Allow deletes** is off, the same as if it had called `delete_task` itself.

## What agents did

Every skill load, tool run and proposal is written to your own `audit_events` trail,
with the surface it came from (`agent:mcp` or `agent:agent-lab`), and shown under **What
agents did**. A refused run is recorded as `denied`, and a failed one as `error` with the
step it stopped at.

## Changing this

- What a step may call is `CUSTOM_TOOL_ACTIONS` in `src/lib/customTools.ts` **and**
  `private.custom_tool_steps_valid` in the migration. `src/test/custom-tools.test.ts`
  fails if they differ, and does the same for the reserved names and the name pattern.
- A new agent capability is still an action in `appActions.ts` first (rule 9). Adding it
  to `CUSTOM_TOOL_ACTIONS` is a separate decision: only actions that stay inside the
  caller's own rows belong there.
- The six actions are in `appActions.ts`, the six MCP tools in `src/lib/mcp/tools/`, and
  the six `AGENT_TOOLS` entries in `appAgent.ts`. `src/test/agent-skills.test.ts` fails
  if one surface is missing one.

## Switching it on

Run `supabase db push` (`20261011120000_jackie_skills_and_tools.sql`). Until then the
tools answer that the tables do not exist, and `/skills` says the same with the command
to run.
