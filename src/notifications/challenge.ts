/** Shared exact callback-control oracle. No transport or persistence. */
export function acceptedChallenge(body: Uint8Array, expected: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return false;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => key !== "challenge") ||
    !("challenge" in parsed) ||
    typeof parsed.challenge !== "string"
  )
    return false;
  const actual = new TextEncoder().encode(parsed.challenge);
  const wanted = new TextEncoder().encode(expected);
  let difference = actual.length ^ wanted.length;
  for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
    difference |= (actual[i] ?? 0) ^ (wanted[i] ?? 0);
  }
  return difference === 0;
}
