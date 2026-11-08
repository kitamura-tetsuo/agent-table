import type { GuestDO } from "./objects/guest";
import type { TableDO } from "./objects/table";

declare global {
  namespace Cloudflare {
    interface Env {
      TABLES: DurableObjectNamespace<TableDO>;
      GUESTS: DurableObjectNamespace<GuestDO>;
      PUBLIC_ORIGIN: string;
      ENABLE_MCP_SUBSCRIPTIONS: string;
      ENABLE_OPENAI_EVENTS: string;
      ALLOW_NEW_GUESTS: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "TableDO" | "GuestDO";
    }
  }
  type Env = Cloudflare.Env;
}
