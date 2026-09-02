import { defineSchema } from "convex/server";

import { developmentTables } from "./developmentSchema.js";
import { omegaTables } from "./omegaSchema.js";
import baseSchema from "./schemaBase.js";

export default defineSchema({
  ...baseSchema.tables,
  ...omegaTables,
  ...developmentTables,
});
