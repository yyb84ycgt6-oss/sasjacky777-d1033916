import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listTasks from "./tools/list-tasks";
import createTask from "./tools/create-task";
import updateTaskStatus from "./tools/update-task-status";
import searchMemory from "./tools/search-memory";
import rememberFact from "./tools/remember-fact";
import listConversations from "./tools/list-conversations";

// The OAuth issuer must be the direct Supabase host, built from the project ref
// (inlined at build time, so this stays import-safe).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "sas-jacky",
  title: "SAS-JACKY",
  version: "0.1.0",
  instructions:
    "Tools for SAS-JACKY (Jackie). Read and manage the signed-in user's tasks, long-term memory facts, and chat conversations. All tools act as the authenticated user.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listTasks, createTask, updateTaskStatus, searchMemory, rememberFact, listConversations],
});
