import { pipeline, stage } from "../builder/index.js";

export default pipeline("create-jira-issues", {
  description:
    "Decompose PM documents or feature descriptions into vertical-slice Jira issues and create them via the Atlassian MCP. Requires the Atlassian MCP.",
  stages: [
    stage("draft", {
      agent: "jira-planner",
      completion: "tool_signal",
      fork: false,
      // max: 3 leaves headroom for the synthetic `codebase-learnings` skill
      // injected by the learning-loop alongside the pinned writing-style skill.
      skills: { dynamic: false, pinned: ["writing-style"], max: 3 },
    }),
    stage("create", {
      agent: "jira-planner",
      completion: "tool_signal",
      fork: true,
    }),
  ],
});
