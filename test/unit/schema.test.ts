import { describe, expect, it } from "vitest";
import {
  APPLICATION_SCHEMA_VERSION,
  migrations,
} from "../../schema/migrations";

describe("application schema manifest", () => {
  it("is a contiguous, immutable forward-only migration sequence", () => {
    expect(migrations.map((migration) => migration.version)).toEqual([1]);
    expect(APPLICATION_SCHEMA_VERSION).toBe(1);
    expect(
      migrations.every((migration) => migration.statements.length > 0),
    ).toBe(true);
  });
});
