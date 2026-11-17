export {
  StaticClientAuthenticator,
  type ClientAuthenticator,
  type ClientIdentity,
  type StaticClientCredential,
} from "./auth/static-auth.ts";
export {
  DeviceRegistry,
  generateDeviceCredential,
  hashDeviceCredential,
  type DeviceBinding,
} from "./devices/registry.ts";
export {
  DeviceRouter,
  type DeviceConnectionHandle,
  type DeviceToRelayMessage,
  type RelayToDeviceMessage,
} from "./routing/device-router.ts";
export {
  PolicyStore,
  ALL_TOOL_FAMILIES,
  CANONICAL_OPERATIONS_BY_FAMILY,
  createUniversalOwnerPermissionSet,
  createProfilePermissionSet,
  evaluatePermissionSet,
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
