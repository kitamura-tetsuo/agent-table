import { expect, test } from "@playwright/test";

const invitation = [
  "at1",
  "a0c7bd91-9488-4b59-9fab-77443f399f6a",
  "ac3d5e6f-76b5-4fa7-8a35-930e0299b911",
  "Z".repeat(43),
].join(".");

test("fragment-only invitation is staged locally and never sent in a GET URL", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/guest");
  await page.getByRole("button", { name: "Create a new guest" }).click();
  await expect(page).toHaveTitle("Agent Table — Guest identity");
  await expect(
    page.getByText("Your browser holds a valid session"),
  ).toBeVisible();

  await page.goto(`/join#${invitation}`);
  await expect(page).toHaveTitle("Agent Table — Join invitation");
  await expect(
    page.getByText("including messages posted before you join", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("not end-to-end encrypted", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve joining as this guest" }),
  ).toBeEnabled();
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.locator('input[name="invitation"]').inputValue()).toBe(
    invitation,
  );
  expect(
    (await page.locator('input[name="request_id"]').inputValue()).length,
  ).toBeGreaterThan(16);
  expect(requests.some((url) => url.includes(invitation))).toBe(false);

  // This synthetic invitation was never issued: confirmation must not create a seat.
  await page
    .getByRole("button", { name: "Approve joining as this guest" })
    .click();
  await expect(page.locator("body")).toContainText("Invitation invalid");
  expect(requests.some((url) => url.includes(invitation))).toBe(false);
});
