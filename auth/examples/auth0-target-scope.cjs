"use strict";

const ACCESS_SCOPE = "tetherplane:access";
const DENIAL = "Tetherplane authorization is unavailable";
const SUPPORTED_PROTOCOLS = new Set([
  "oidc-basic-profile",
  "oauth2-refresh-token",
]);

// Dedicated Auth0 Post Login Action example. Operator enrollment must also
// agree with provider grants and the relay's exact subject/client binding.
// Target scopes still pass through Auth0 authorization policy and consent;
// requesting this scope does not guarantee that it reaches an access token.
exports.onExecutePostLogin = async (event, api) => {
  const resource = event?.secrets?.TETHERPLANE_RESOURCE;
  if (!isCanonicalResource(resource)) {
    return;
  }
  if (event?.resource_server?.identifier !== resource) {
    return;
  }

  let bindings;
  try {
    const configured = event?.secrets?.TETHERPLANE_BINDINGS_JSON;
    if (typeof configured !== "string") {
      return;
    }
    bindings = JSON.parse(configured);
  } catch {
    return;
  }
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    !bindings.every(isExactBinding)
  ) {
    return;
  }

  const subject = event?.user?.user_id;
  const clientId = event?.client?.client_id;
  if (
    !isExactIdentifier(subject) ||
    !isExactIdentifier(clientId) ||
    !bindings.some(
      (binding) => binding.subject === subject && binding.clientId === clientId,
    )
  ) {
    return;
  }

  if (
    !SUPPORTED_PROTOCOLS.has(event?.transaction?.protocol) ||
    typeof api?.transaction?.addTargetScope !== "function"
  ) {
    return deny(api);
  }
  const targetScopes = event?.transaction?.target_scopes;
  if (
    targetScopes !== undefined &&
    (!Array.isArray(targetScopes) ||
      targetScopes.some((scope) => typeof scope !== "string"))
  ) {
    return deny(api);
  }
  if (targetScopes?.includes(ACCESS_SCOPE)) {
    return;
  }
  try {
    await api.transaction.addTargetScope(ACCESS_SCOPE);
  } catch {
    return deny(api);
  }
};

function isCanonicalResource(value) {
  if (typeof value !== "string" || /\s/.test(value)) {
    return false;
  }
  try {
    const resource = new URL(value);
    return (
      resource.protocol === "https:" &&
      resource.pathname === "/mcp" &&
      !resource.username &&
      !resource.password &&
      !resource.search &&
      !resource.hash
    );
  } catch {
    return false;
  }
}

function isExactIdentifier(value) {
  return typeof value === "string" && value.length > 0 && !/[\s*?\x00-\x1F\x7F]/.test(value);
}

function isExactBinding(binding) {
  return (
    binding !== null &&
    typeof binding === "object" &&
    !Array.isArray(binding) &&
    Object.keys(binding).length === 2 &&
    isExactIdentifier(binding.subject) &&
    isExactIdentifier(binding.clientId)
  );
}

function deny(api) {
  if (typeof api?.access?.deny !== "function") {
    throw new Error(DENIAL);
  }
  api.access.deny(DENIAL);
}
