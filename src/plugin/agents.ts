import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function resolveAgentsDir(): Promise<string> {
  // Built: dist/chunk-*.js → ../agents. Source: src/plugin/agents.ts → ../../agents.
  const candidates = [join(__dirname, "..", "agents"), join(__dirname, "..", "..", "agents")];
  for (const dir of candidates) {
    try {
      await access(join(dir, "planner.md"));
      return dir;
    } catch {}
  }
  throw new Error(`Could not locate agents/ dir. Tried: ${candidates.join(", ")}`);
}

type BashPermission = "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">;

interface AgentDef {
  name: string;
  description: string;
  canWrite: boolean;
  bash: BashPermission;
}

// Common safe commands that agents need to explore and build
const READ_BASH: BashPermission = {
  "*": "ask",
  "ls *": "allow",
  "cat *": "allow",
  "find *": "allow",
  "grep *": "allow",
  "rg *": "allow",
  "wc *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "git *": "allow",
  "gh *": "allow",
  "dotnet *": "allow",
  "npm *": "allow",
  "npx *": "allow",
  "node *": "allow",
  "bun *": "allow",
  "cargo *": "allow",
  "go *": "allow",
  "python *": "allow",
  "pip *": "allow",
  "mix *": "allow",
  "make *": "allow",
};

const WRITE_BASH: BashPermission = {
  ...READ_BASH,
  "mkdir *": "allow",
  "cp *": "allow",
  "mv *": "allow",
};

const AGENTS: AgentDef[] = [
  {
    name: "planner",
    description: "Pre-implementation planner. Reads an issue, outputs a sequenced test plan.",
    canWrite: true,
    bash: READ_BASH,
  },
  {
    name: "architecture-reviewer",
    description: "Analyzes codebase for architectural friction and critiques plans.",
    canWrite: false,
    bash: READ_BASH,
  },
  {
    name: "implementor",
    description: "Implements features using strict TDD (red-green-refactor).",
    canWrite: true,
    bash: WRITE_BASH,
  },
  {
    name: "refactorer",
    description: "Post-implementation refactor agent. Extracts shared patterns.",
    canWrite: true,
    bash: WRITE_BASH,
  },
  {
    name: "code-reviewer",
    description: "Structured, checklist-driven code reviewer. Read-only.",
    canWrite: false,
    bash: READ_BASH,
  },
  { name: "review-judge", description: "Validates code review findings. Read-only.", canWrite: false, bash: READ_BASH },
  {
    name: "pr-review-judge",
    description: "Validates code review findings for standalone PR review (never rejects). Read-only.",
    canWrite: false,
    bash: READ_BASH,
  },
  {
    name: "pr-commenter",
    description: "Posts validated code review findings to GitHub PRs via gh api. Read-only filesystem; gh allowed.",
    canWrite: false,
    bash: READ_BASH,
  },
  {
    name: "investigator",
    description: "Explores codebases and produces structured technical documents (spikes, RFCs).",
    canWrite: true,
    bash: WRITE_BASH,
  },
  {
    name: "jira-planner",
    description: "Decomposes feature descriptions into Jira issues and creates them via the Atlassian MCP.",
    canWrite: true,
    bash: WRITE_BASH,
  },
];

interface AgentConfig {
  description: string;
  mode: "subagent";
  prompt: string;
  permission: {
    bash: BashPermission;
    edit: "allow" | "deny";
    write: "allow" | "deny";
  };
}

export async function loadAgentConfigs(): Promise<Record<string, AgentConfig>> {
  const configs: Record<string, AgentConfig> = {};
  const agentsDir = await resolveAgentsDir();

  for (const agent of AGENTS) {
    let prompt: string;
    try {
      prompt = await readFile(join(agentsDir, `${agent.name}.md`), "utf-8");
    } catch {
      continue;
    }

    configs[agent.name] = {
      description: agent.description,
      mode: "subagent",
      prompt,
      permission: {
        bash: agent.bash,
        edit: agent.canWrite ? "allow" : "deny",
        write: agent.canWrite ? "allow" : "deny",
      },
    };
  }

  return configs;
}
