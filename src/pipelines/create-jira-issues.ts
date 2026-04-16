import { pipeline, stage } from "../builder/index.js";

export default pipeline("create-jira-issues", {
  description:
    "Decompose PM documents or feature descriptions into vertical-slice Jira issues and create them via the Atlassian MCP. Requires the Atlassian MCP.",
  stages: [
    stage("draft", {
      agent: "jira-planner",
      completion: "tool_signal",
      fork: false,
      skills: { dynamic: false, pinned: ["writing-style"], max: 2 },
    }),
    stage("create", {
      agent: "jira-planner",
      completion: "tool_signal",
      fork: true,
    }),
  ],
});
