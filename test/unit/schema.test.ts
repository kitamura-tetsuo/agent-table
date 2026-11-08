import { describe, expect, it } from "vitest";
import {
  APPLICATION_SCHEMA_VERSION,
  migrations,
} from "../../schema/migrations";

describe("application schema manifest", () => {
  it("is a contiguous, immutable forward-only migration sequence", () => {
    expect(migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(APPLICATION_SCHEMA_VERSION).toBe(6);
    expect(
      migrations.every(
        (migration) =>
          migration.statements.length > 0 || "componentStatements" in migration,
      ),
    ).toBe(true);
  });
});
