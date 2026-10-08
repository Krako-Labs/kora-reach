export const DECISION_FIELDS = ["teamId", "distributionName", "releaseOwner", "bundleId",
  "minimumMacOS", "architecture", "channel", "signingAccess", "notaryAccess"];
export const DECISION_ERROR = "Release decisions are invalid; use non-secret planning fields only.";
export function validateDecisions(value) {
  if (!value || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(k => k !== "version" && !DECISION_FIELDS.includes(k)) ||
      DECISION_FIELDS.some(k => !(k in value))) throw new Error(DECISION_ERROR);
  for (const key of DECISION_FIELDS) {
    const s = value[key];
    if (s !== null && (typeof s !== "string" || s.length < 1 || s.length > 160 ||
        !/^[A-Za-z0-9 ._@:/()-]+$/.test(s))) throw new Error(DECISION_ERROR);
  }
  if (value.teamId !== null && !/^[A-Z0-9]{10}$/.test(value.teamId)) throw new Error(DECISION_ERROR);
  if (value.bundleId !== null && !/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(value.bundleId)) throw new Error(DECISION_ERROR);
  if (value.minimumMacOS !== null && !/^\d{2}\.\d{1,2}(\.\d{1,2})?$/.test(value.minimumMacOS)) throw new Error(DECISION_ERROR);
  if (value.architecture !== null && value.architecture !== "arm64") throw new Error(DECISION_ERROR);
  if (value.channel !== null && !["private-validation", "direct-download"].includes(value.channel)) throw new Error(DECISION_ERROR);
  return { ...value };
}
export function readiness(decisions, nodeEntitlements) {
  validateDecisions(decisions);
  const missing = DECISION_FIELDS.filter(k => decisions[k] === null);
  return {
    format: 1, kind: "candidate-preflight", distributionAllowed: false,
    integrityMeaning: "Local manifest consistency, not authenticated release provenance.",
    missingDecisions: missing,
    blockers: [...missing.map(k => "decision_missing:" + k),
      "candidate_identity_only", "developer_id_validation_pending",
      ...(nodeEntitlements["com.apple.security.get-task-allow"] === true ? ["node_debug_entitlement"] : []),
      "release_entitlements_unvalidated", "notarization_missing", "supported_os_matrix_unverified"],
    nodeEntitlementKeys: Object.keys(nodeEntitlements).sort(),
    note: "Planning fields never establish ownership, signing authority, notarization or support."
  };
}
