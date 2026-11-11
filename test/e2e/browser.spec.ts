import { expect, test } from "@playwright/test";

test("serves the real guest choice page and health endpoint", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Agent Table — Guest identity");
  await expect(
    page.getByRole("heading", { name: "Agent Table" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Choose your guest identity" }),
  ).toBeVisible();
  await expect(
    page.getByText(/cannot reconstruct that browser identity/),
  ).toBeVisible();

  const health = await request.get("/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  expect(health.headers()["cache-control"]).toBe("no-store");
});
