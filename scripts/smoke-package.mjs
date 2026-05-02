import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "lattice-package-"));

function run(command, args, cwd = temp) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
  const packOutput = execFileSync("npm", ["pack", "--silent", "--pack-destination", temp], {
    cwd: root,
    encoding: "utf-8",
  })
    .trim()
    .split(/\r?\n/)
    .at(-1);
  if (!packOutput) throw new Error("npm pack did not report a tarball");

  await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  run("npm", ["install", "--silent", "--ignore-scripts", join(temp, packOutput)]);

  await writeFile(
    join(temp, "index.mjs"),
    [
      'import plugin from "@callumvass/lattice/plugin";',
      'import { pipeline, stage } from "@callumvass/lattice/builder";',
      'import { pipelineDefinitionSchema } from "@callumvass/lattice/schema";',
      'const definition = pipeline("smoke", { stages: [stage("run", { agent: "builder", completion: "idle" })] });',
      'if (!plugin?.id) throw new Error("plugin export missing");',
      'pipelineDefinitionSchema.parse(definition);',
    ].join("\n"),
  );
  run(process.execPath, [join(temp, "index.mjs")]);

  await mkdir(join(temp, "src"));
  await writeFile(
    join(temp, "src", "pipeline.ts"),
    [
      'import { pipeline, stage } from "@callumvass/lattice/builder";',
      'import type { PipelineDefinition } from "@callumvass/lattice/schema";',
      'export const definition: PipelineDefinition = pipeline("typed-smoke", {',
      '  stages: [stage("run", { agent: "builder", completion: "idle" })],',
      '});',
    ].join("\n"),
  );
  await writeFile(
    join(temp, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", temp]);
} finally {
  await rm(temp, { recursive: true, force: true });
}
