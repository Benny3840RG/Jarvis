import { defineSchema } from "convex/server";

import { omegaTables } from "./omegaSchema.js";
import baseSchema from "./schemaBase.js";

export default defineSchema({
  ...baseSchema.tables,
  ...omegaTables,
});
