/** Approval of shared deletion is a browser-only operation. */
export const DELETE_CONFIRMATION_MS = 5 * 60 * 1000;

export type BrowserDeletionCredential = {
  readonly guestId: string;
  readonly sessionId: string;
  readonly secret: string;
};

export type DeletionReceipt =
  | {
      confirmation_required: true;
      confirmation_url: string;
      expires_at: string;
    }
  | { confirmation_required: false; state: "deleted" };

export type DeletionView = {
  state: "pending" | "denied" | "expired" | "deleted";
  expires_at?: string;
};
