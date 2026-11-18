export {
  StaticClientAuthenticator,
  RESERVED_NON_OWNER_PRINCIPAL_PREFIXES,
  hasNonOwnerPrincipalPrefix,
  isAuthorizedOwnerIdentity,
  validateConfiguredIdentityRole,
  type ClientAuthenticator,
  type ClientIdentity,
  type ClientIdentityRole,
  type StaticClientCredential,
} from "./auth/static-auth.ts";
export {
  DEFAULT_MAX_PENDING_PAIRINGS,
  DeviceRegistry,
  PairingCapacityError,
  generateDeviceCredential,
  hashDeviceCredential,
  type DeviceBinding,
} from "./devices/registry.ts";
export {
  SerializedJsonFileWriter,
  type PersistFileOps,
} from "./persistence/atomic-json.ts";
export type {
  EndpointRateLimit,
  RelayRateLimitConfig,
} from "./devices/control-http.ts";
export {
  DeviceRouter,
  type DeviceConnectionHandle,
  type DeviceToRelayMessage,
  type RelayToDeviceMessage,
} from "./routing/device-router.ts";
export {
  DEFAULT_MAX_AUDIT_HISTORY,
  PolicyStore,
  ALL_CANONICAL_OPERATIONS,
  ALL_TOOL_FAMILIES,
  CANONICAL_OPERATIONS_BY_FAMILY,
  assertCanonicalCapabilities,
  createUniversalOwnerPermissionSet,
  createProfilePermissionSet,
  evaluatePermissionSet,
  isCanonicalCapability,
  toolFamilyForCapability,
  type DevicePolicyRecord,
  type DeviceSyncStatus,
  type IdentityUsageRecord,
  type PermissionProfileId,
  type PolicyAuditEvent,
  type PolicyMutationInput,
  type PolicySnapshot,
  type PrincipalPermissionSet,
  type PrincipalRole,
  type SynchronizedDevicePolicy,
  type ToolFamily,
} from "./policy/policy-store.ts";
export { renderControlPortalHtml } from "./portal/portal-ui.ts";
export {
  RelayServer,
  type RelayListenAddress,
} from "./server.ts";
export { OidcClientAuthenticator, type OidcOptions } from "./auth/oidc-auth.ts";
export type { OAuthResource } from "./auth/oauth-resource.ts";
