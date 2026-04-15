import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LatticeConfig } from "../schema/index.js";

const CONFIG_FILENAME = "config.jsonc";
const LATTICE_DIR = ".lattice";

function stripJsonComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

async function readJsonc<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(stripJsonComments(raw)) as T;
  } catch {
    return undefined;
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

  const globalConfig = await readJsonc<LatticeConfig>(globalPath);
  const projectConfig = await readJsonc<LatticeConfig>(projectPath);

  const base: LatticeConfig = globalConfig ?? {};
  const override: LatticeConfig = projectConfig ?? {};

  return mergeConfigs(base, override);
}
