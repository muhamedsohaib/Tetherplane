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
  RelayServer,
  type RelayListenAddress,
} from "./server.ts";
export { OidcClientAuthenticator, type OidcOptions } from "./auth/oidc-auth.ts";
export {
  CompositeClientAuthenticator,
  type CompositeAuthOptions,
} from "./auth/composite-auth.ts";
export type { OAuthResource } from "./auth/oauth-resource.ts";
