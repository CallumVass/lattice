import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LatticeConfig, latticeConfigSchema } from "../schema/index.js";

const CONFIG_FILENAME = "config.jsonc";
const LATTICE_DIR = ".lattice";

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    result += char;
  }

  return result;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (("code" in error && error.code === "ENOENT") || error.message.includes("ENOENT"));
}

async function readJsonc(path: string): Promise<LatticeConfig | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = latticeConfigSchema.safeParse(JSON.parse(stripJsonComments(raw)));
    if (!parsed.success) {
      throw new Error(`Invalid lattice config at ${path}: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSONC in lattice config at ${path}: ${error.message}`);
    throw error;
  }
}

function mergeConfigs(base: LatticeConfig, override: LatticeConfig): LatticeConfig {
  return {
    agents: { ...base.agents, ...override.agents },
    pipelines: { ...base.pipelines, ...override.pipelines },
    skills: override.skills ?? base.skills,
  };
}

export async function loadConfig(projectDir: string): Promise<LatticeConfig> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const globalPath = join(home, ".config", "lattice", CONFIG_FILENAME);
  const projectPath = join(projectDir, LATTICE_DIR, CONFIG_FILENAME);

  const globalConfig = await readJsonc(globalPath);
  const projectConfig = await readJsonc(projectPath);

  const base: LatticeConfig = globalConfig ?? {};
  const override: LatticeConfig = projectConfig ?? {};

  return mergeConfigs(base, override);
}
