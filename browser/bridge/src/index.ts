export {
  BrowserOwnershipRegistry,
  BrowserPolicyError,
  type BrowserMode,
  type BrowserOperation,
  type BrowserOwnership,
  type BrowserPageRecord,
} from "./policy.ts";
export type SemanticReference = {
  ref_id: string;
  role: string;
  accessible_name: string;
  ancestry: Array<{
    role: string;
    accessible_name: string;
  }>;
  document_id: string;
  frame_id: string;
  snapshot_revision: number;
};

export {
  SemanticSnapshotEngine,
  StaleReferenceError,
  type BackendSemanticNode,
  type BrowserSemanticSnapshot,
  type SnapshotSemanticNode,
} from "./semantic.ts";

export {
  VerifiedActionEngine,
  type BrowserBridgeBackend,
  type BrowserExpectation,
  type BrowserObservedState,
  type BrowserSemanticAction,
  type ResolvedBrowserAction,
  type VerifiedActionResult,
  type VerifiedActionState,
} from "./action.ts";

export {
  startExtensionBridgeServer,
  type AuthenticatedExtensionClient,
  type ExtensionBridgeMessage,
  type ExtensionBridgeServer,
} from "./extension-session.ts";

export {
  ExtensionBrowserBackend,
  ExtensionBackendError,
  type ExtensionCommandTransport,
  type ExtensionPageInfo,
} from "./extension-backend.ts";

export {
  CdpBackendError,
  CdpBrowserBackend,
  buildIsolatedChromiumArgs,
  type CdpCapabilities,
  type CdpControl,
  type CdpFrame,
  type CdpFrameObservation,
  type CdpPageInfo,
  type CdpTargetInfo,
} from "./cdp-backend.ts";

export {
  DEFAULT_CDP_LAUNCH_TIMEOUT_MS,
  findInstalledChromium,
  launchCdpOwnedBrowser,
  type LaunchedCdpControl,
} from "./cdp-control.ts";

export {
  BrowserOperationalEngine,
  type BrowserCheckpoint,
  type BrowserDiagnosticEvent,
  type BrowserDownload,
  type BrowserOperationalBackend,
  type RawBrowserDiagnosticEvent,
  type RawBrowserDownload,
} from "./operations.ts";

export {
  BrowserBridgeService,
  startBrowserRpcServer,
  type BrowserRpcServer,
  type BrowserServiceBackend,
  type BrowserServicePage,
} from "./rpc-server.ts";

export {
  startExtensionPairingBroker,
  type ExtensionPairingBroker,
} from "./pairing.ts";
