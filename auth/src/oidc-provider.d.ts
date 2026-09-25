declare module "oidc-provider" {
  import type {
    IncomingMessage,
    ServerResponse,
  } from "node:http";

  export type ProviderRequestHandler = (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void;

  export class Provider {
    constructor(
      issuer: string,
      configuration?: Record<string, unknown>,
    );
    callback(): ProviderRequestHandler;
  }

  export const errors: {
    InvalidTarget: new () => Error;
  };
}
