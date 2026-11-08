import { DurableObject } from "cloudflare:workers";
import {
  initializeApplicationSchema,
  readApplicationSchemaVersion,
} from "../shared/schema";

export class TableDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeApplicationSchema(ctx.storage, "table");
  }

  // Internal binding check only. Table operations are not implemented yet.
  schemaVersion(): number {
    return readApplicationSchemaVersion(this.ctx.storage);
  }
}
