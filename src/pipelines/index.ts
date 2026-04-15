import type { PipelineDefinition } from "../schema/index.js";
import architecture from "./architecture.js";
import implement from "./implement.js";
import review from "./review.js";

export const builtinPipelines: PipelineDefinition[] = [architecture, review, implement];
