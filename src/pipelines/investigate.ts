import { pipeline, stage } from "../builder/index.js";

export default pipeline("investigate", {
  description:
    "Research a topic or produce a spike/RFC. Gathers inputs, fetches references, explores the codebase, writes a markdown file.",
  stages: [
    stage("investigate", {
      agent: "investigator",
      completion: "idle",
      fork: false,
      skills: { dynamic: false, pinned: ["writing-style", "opensrc"], max: 2 },
    }),
  ],
});
