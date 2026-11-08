import type { GuestDO } from "./objects/guest";
import type { TableDO } from "./objects/table";

declare global {
  namespace Cloudflare {
    interface Env {
      TABLES: DurableObjectNamespace<TableDO>;
      GUESTS: DurableObjectNamespace<GuestDO>;
      OAUTH_SERIALIZER: DurableObjectNamespace<import("./auth/token-do").OAuthTokenDO>;
      OAUTH_KV: KVNamespace;
      PUBLIC_ORIGIN: string;
      ENABLE_MCP_SUBSCRIPTIONS: string;
      ENABLE_OPENAI_EVENTS: string;
      ALLOW_NEW_GUESTS: string;
      INVITATION_RESPONSE_KEYRING?: string;
      CALLBACK_CREDENTIAL_KEYRING?: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "TableDO" | "GuestDO" | "OAuthTokenDO";
    }
  }
  type Env = Cloudflare.Env;
}
