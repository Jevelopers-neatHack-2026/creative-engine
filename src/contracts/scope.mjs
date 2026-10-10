import { expectObject, expectString, fail } from "./validation.mjs";

const SCOPE_IDS = ["tenant_id", "project_id"];
const OPTIONAL_ID_KEYS = ["job_id", "artifact_id", "design_version_id", "brief_id"];

export function assertTrustedScope(candidate, trustedScope, contract = "trusted-scope/1") {
  expectObject(candidate, contract, "candidate");
  expectObject(trustedScope, contract, "trusted_scope");

  for (const key of SCOPE_IDS) {
    const actual = expectString(candidate[key], contract, key, { maxLength: 200 });
    const trusted = expectString(trustedScope[key], contract, "trusted_scope." + key, { maxLength: 200 });
    if (actual !== trusted) {
      fail("scope_mismatch", contract, key, key + " does not match authenticated application context.");
    }
  }

  for (const key of OPTIONAL_ID_KEYS) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) {
      const actual = expectString(candidate[key], contract, key, { maxLength: 200 });
      const trusted = trustedScope[key];
      if (typeof trusted !== "string" || actual !== trusted) {
        fail("scope_mismatch", contract, key, key + " does not match the trusted object reference.");
      }
    }
  }
  return candidate;
}
