/**
 * Local operator adapter only. Opening a store can migrate/write; plan/readback
 * themselves are read-only. No CLI, HTTP route, process kill or runtime enable.
 * The caller must verify the concrete owner's evidence covers ALL transports
 * represented in the exact active-set plan, and keep all producers paused.
 */
export function planUncertainRecovery(store) {
  return store.planOperatorRecovery();
}
export function applyUncertainRecovery(store, approvedRequest) {
  return store.reconcileOperatorRecovery(approvedRequest);
}
export function readUncertainRecovery(store, operationId) {
  return store.readOperatorRecovery(operationId);
}
