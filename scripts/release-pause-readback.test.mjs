import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeConfig,
  makeProviderMock,
} from "../test/helpers/release-fixtures.mjs";
import { verifyNormalPause } from "./release-pause-readback.mjs";

const expectedVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function pausedFixture(environment = "staging") {
  const config = makeConfig(environment);
  const peer = makeConfig(environment === "staging" ? "production" : "staging");
  config.vars.ALLOW_NEW_TABLES = "false";
  peer.vars.ALLOW_NEW_TABLES = "false";
  return { config, peer, mock: makeProviderMock(config, peer) };
}

function targetBindings(mock, config) {
  const base = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
  return {
    settings: mock.routes.get(`${base}/settings`).bindings,
    version: mock.routes.get(`${base}/versions/${expectedVersionId}`).resources
      .bindings,
  };
}

test("normal staging and production pauses prove exact active version and disabled intake", async () => {
  for (const environment of ["staging", "production"]) {
    const { config, peer, mock } = pausedFixture(environment);
    const result = await verifyNormalPause({
      config,
      peer,
      expectedVersionId,
      cloudflareRead: mock.read,
    });
    assert.equal(result.verified, true);
    assert.equal(result.environment, environment);
    assert.equal(result.versionId, expectedVersionId);
    assert.equal(result.admission, "paused");
    assert.deepEqual(Object.keys(result).sort(), [
      "admission",
      "buildSha",
      "deploymentId",
      "environment",
      "verified",
      "versionId",
      "workerName",
    ]);
  }
});

test("candidate with admission or delivery enabled is rejected before provider access", async () => {
  const { config, peer } = pausedFixture();
  config.vars.ALLOW_NEW_TABLES = "true";
  await assert.rejects(
    verifyNormalPause({
      config,
      peer,
      expectedVersionId,
      cloudflareRead: () => {
        throw new Error("provider must not be contacted");
      },
    }),
    /pause-config-not-disabled/,
  );
  config.vars.ALLOW_NEW_TABLES = "false";
  config.vars.ENABLE_OPENAI_EVENTS = "true";
  await assert.rejects(
    verifyNormalPause({
      config,
      peer,
      expectedVersionId,
      cloudflareRead: () => {},
    }),
    /pause-config-not-disabled/,
  );
});

test("Wrangler rollback retaining newer service settings fails closed in both directions", async () => {
  for (const surface of ["settings", "version"]) {
    const { config, peer, mock } = pausedFixture();
    targetBindings(mock, config)[surface].find(
      (item) => item.name === "ALLOW_NEW_TABLES",
    ).text = "true";
    await assert.rejects(
      verifyNormalPause({
        config,
        peer,
        expectedVersionId,
        cloudflareRead: mock.read,
      }),
      /provider-version-config-unverified/,
    );
  }
});

test("matching but enabled provider settings and version cannot claim a pause", async () => {
  const { config, peer, mock } = pausedFixture();
  for (const binding of Object.values(targetBindings(mock, config))) {
    binding.find((item) => item.name === "ALLOW_NEW_GUESTS").text = "true";
  }
  await assert.rejects(
    verifyNormalPause({
      config,
      peer,
      expectedVersionId,
      cloudflareRead: mock.read,
    }),
    /provider-deployed-config-mismatch/,
  );
});

test("a valid but unexpected deployed version denies the rollback receipt", async () => {
  const { config, peer, mock } = pausedFixture();
  await assert.rejects(
    verifyNormalPause({
      config,
      peer,
      expectedVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      cloudflareRead: mock.read,
    }),
    /pause-version-id-mismatch/,
  );
});

test("unknown release state and invalid version IDs deny before provider access", async () => {
  const { config, peer, mock } = pausedFixture();
  config.vars.RESTORE_QUARANTINE = "true";
  await assert.rejects(
    verifyNormalPause({
      config,
      peer,
      expectedVersionId,
      cloudflareRead: mock.read,
    }),
    /pause-release-state-unverified/,
  );
  config.vars.RESTORE_QUARANTINE = "false";
  await assert.rejects(
    verifyNormalPause({
      config,
      peer,
      expectedVersionId: "not-an-uuid",
      cloudflareRead: mock.read,
    }),
    /pause-expected-version-invalid/,
  );
});
