import type { AdmissionDO } from "./objects/admission";
import type { GuestDO } from "./objects/guest";
import type { TableDO } from "./objects/table";

declare global {
  namespace Cloudflare {
    interface Env {
      TABLES: DurableObjectNamespace<TableDO>;
      ADMISSION: DurableObjectNamespace<AdmissionDO>;
      GUESTS: DurableObjectNamespace<GuestDO>;
      OAUTH_SERIALIZER: DurableObjectNamespace<
        import("./auth/token-do").OAuthTokenDO
      >;
      OAUTH_KV: KVNamespace;
      PUBLIC_ORIGIN: string;
      ENABLE_MCP_SUBSCRIPTIONS: string;
      ENABLE_OPENAI_EVENTS: string;
      ALLOW_NEW_GUESTS: string;
      ALLOW_NEW_TABLES: string;
      ALLOW_OUTBOUND_NOTIFICATIONS: string;
      GUEST_CHALLENGE_MODE?: string;
      TURNSTILE_SITE_KEY?: string;
      TURNSTILE_SECRET?: string;
      EDGE_GUEST_RATE_PER_MINUTE?: string;
      EDGE_DCR_RATE_PER_MINUTE?: string;
      EDGE_PROTOCOL_RATE_PER_MINUTE?: string;
      EDGE_APPLICATION_RATE_PER_MINUTE?: string;
      EDGE_INVITATION_RATE_PER_MINUTE?: string;
      PRINCIPAL_RATE_PER_MINUTE?: string;
      INVITATION_RESPONSE_KEYRING?: string;
      CALLBACK_CREDENTIAL_KEYRING?: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "TableDO" | "GuestDO" | "OAuthTokenDO" | "AdmissionDO";
    }
  }
  type Env = Cloudflare.Env;
}
