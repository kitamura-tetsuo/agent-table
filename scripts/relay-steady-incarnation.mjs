const bootPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const containerPattern = /^[a-f0-9]{64}$/;
export function validIncarnation(p) {
  return (
    !!p &&
    bootPattern.test(p.bootId) &&
    containerPattern.test(p.id) &&
    Number.isSafeInteger(p.pid) &&
    p.pid > 0 &&
    /^\d+$/.test(p.start) &&
    /^\d+:\d+$/.test(p.namespace) &&
    typeof p.cgroup === "string" &&
    p.cgroup.split(/[/.:\n-]+/).includes(p.id)
  );
}
export function sameIncarnation(a, b) {
  return (
    validIncarnation(a) &&
    validIncarnation(b) &&
    ["bootId", "id", "pid", "start", "namespace", "cgroup"].every(
      (k) => a[k] === b[k],
    )
  );
}
/** An observed new process alone does not retire an old process. */
export function priorIncarnationRetired(previous, current, oldPidReadback) {
  if (
    !validIncarnation(previous) ||
    !validIncarnation(current) ||
    previous.id !== current.id ||
    sameIncarnation(previous, current)
  )
    return false;
  if (previous.bootId !== current.bootId) return true;
  return (
    oldPidReadback?.state === "absent" ||
    (oldPidReadback?.state === "present" &&
      /^\d+$/.test(oldPidReadback.start) &&
      oldPidReadback.start !== previous.start)
  );
}
