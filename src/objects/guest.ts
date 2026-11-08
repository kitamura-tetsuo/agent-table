import { DurableObject } from "cloudflare:workers";
import {
  initializeApplicationSchema,
  readApplicationSchemaVersion,
} from "../shared/schema";

export class GuestDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeApplicationSchema(ctx.storage, "guest");
  }

  // Internal binding check only. Guest admission is not implemented yet.
  schemaVersion(): number {
    return readApplicationSchemaVersion(this.ctx.storage);
  }
}
