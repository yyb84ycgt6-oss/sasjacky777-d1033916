import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listTasks from "./tools/list-tasks";
import createTask from "./tools/create-task";
import updateTask from "./tools/update-task";
import updateTaskStatus from "./tools/update-task-status";
import deleteTask from "./tools/delete-task";
import searchMemory from "./tools/search-memory";
import rememberFact from "./tools/remember-fact";
import forgetFact from "./tools/forget-fact";
import listConversations from "./tools/list-conversations";
import readConversation from "./tools/read-conversation";
import createConversation from "./tools/create-conversation";
import askJackie from "./tools/ask-jackie";

// The OAuth issuer must be the direct Supabase host, built from the project ref
// (inlined at build time, so this stays import-safe).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "sas-jacky",
  title: "SAS-JACKY",
  version: "0.2.0",
  // Read by harnesses (Hermes Agent, DeepSeek Harness) as the server's own
  // guidance, so it says how the tools fit together, not just that they exist.
  instructions:
    "Tools for SAS-JACKY (Jackie), acting as the signed-in user. " +
    "ask_jackie talks to Jackie; she already sees the user's memory and active tasks, and the exchange is saved " +
    "to a conversation in the app. Use list_tasks / create_task / update_task / delete_task for the task board " +
    "(statuses: todo, in_progress, done, blocked), search_memory / remember_fact / forget_fact for long-term " +
    "memory, and list_conversations / read_conversation / create_conversation for chat history. " +
    "Prefer update_task with status done over delete_task. Every tool reports failure with isError and the reason.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    askJackie,
    listTasks,
    createTask,
    updateTask,
    updateTaskStatus,
    deleteTask,
    searchMemory,
    rememberFact,
    forgetFact,
    listConversations,
    readConversation,
    createConversation,
  ],
});
