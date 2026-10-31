import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ClientAuthenticator, ClientIdentity } from "../auth/static-auth.ts";
import { AuthorityError, type OwnerDeviceAuthority } from "./owner-authority.ts";

const LEN0 = "Leno";
type Endpoint = "/owner/leno" | "/owner/leno/grant" | "/owner/leno/enforcement";
const endpointSet = new Set<string>(["/owner/leno", "/owner/leno/grant", "/owner/leno/enforcement"]);
const fieldsMatch = (body: Record<string, unknown>, keys: string[]) =>
  Object.keys(body).length === keys.length && Object.keys(body).every(key => keys.includes(key));

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    length += chunk.length;
    if (length > 8192) throw new AuthorityError("invalid_arguments", "owner update exceeds body limit");
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AuthorityError("invalid_arguments", "owner update requires JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthorityError("invalid_arguments", "owner update requires JSON object");
  return value as Record<string, unknown>;
}

export class OwnerLenoHttpGateway {
  readonly #authority: OwnerDeviceAuthority;
  readonly #authenticator: ClientAuthenticator;
  readonly #handler: (request: IncomingMessage, response: ServerResponse) => void;
  #server: Server | null = null;

  constructor(options: { authority: OwnerDeviceAuthority; authenticator: ClientAuthenticator }) {
    this.#authority = options.authority;
    this.#authenticator = options.authenticator;
    this.#handler = (request, response) => { void this.#handle(request, response); };
  }

  attach(server: Server): void {
    if (this.#server) throw new Error("owner Leno gateway already attached");
    this.#server = server;
    server.on("request", this.#handler);
  }

  close(): void {
    this.#server?.off("request", this.#handler);
    this.#server = null;
  }

  async #owner(request: IncomingMessage): Promise<ClientIdentity | null> {
    const token = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!token) return null;
    const identity = await this.#authenticator.authenticate(token);
    return identity && this.#authority.isOwner(identity) ? identity : null;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = request.url;
    if (typeof raw !== "string" || !raw.startsWith("/owner/leno")) return;
    if (!endpointSet.has(raw)) {
      send(response, 404, {error:{code:"invalid_arguments",message:"Unknown owner Leno action"}});
      return;
    }
    const endpoint = raw as Endpoint;
    try {
      if (request.method !== (endpoint === "/owner/leno" ? "GET" : "POST")) {
        send(response, 405, {error:{code:"invalid_arguments", message:"Unsupported owner action method"}});
        return;
      }
      const identity = await this.#owner(request);
      if (!identity) {
        send(response, 403, {error:{code:"permission_denied", message:"Exact authenticated owner is required"}});
        return;
      }
      if (endpoint === "/owner/leno") {
        send(response, 200, this.#authority.snapshot(identity));
        return;
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
        send(response, 415, {error:{code:"invalid_arguments", message:"JSON content type required"}});
        return;
      }
      const body = await bodyJson(request);
      const state = this.#authority.snapshot(identity);
      if (endpoint === "/owner/leno/grant") {
        if (!fieldsMatch(body, ["revision","clientId","principalId","confirmation"])
          || body.confirmation !== "TRUST Leno"
          || state.enabled || state.enforcedDevices.includes(LEN0)) {
          throw new AuthorityError("invalid_arguments", "Leno grant must be staged with exact owner confirmation before enforcement");
        }
        if (typeof body.clientId !== "string" || typeof body.principalId !== "string"
            || !state.clients.some(c => c.clientId === body.clientId && c.principalId === body.principalId)) {
          throw new AuthorityError("permission_denied", "Client/principal must already be authenticated and observed");
        }
        // One selected AI client per Leno: replacing an old staged grant must
        // not accidentally authorize two clients when the relay restarts.
        // The startup fence already rejects grants to unrelated devices.
        const grants = state.grants.filter(g => g.deviceId !== LEN0)
          .map(g => ({ deviceId:g.deviceId, clientId:g.clientId, principalId:g.principalId, level:g.level }));
        grants.push({deviceId:LEN0, clientId:body.clientId, principalId:body.principalId, level:"full"});
        const revision = await this.#authority.replaceGrants(identity, {revision:body.revision as number, grants});
        send(response, 200, {revision, deviceId:LEN0, staged:true, enabled:false});
        return;
      }
      if (!fieldsMatch(body, ["revision","enabled","confirmation"]) || state.enabled) {
        throw new AuthorityError("invalid_arguments", "Global owner enforcement is not supported by Leno-only gateway");
      }
      const revision = await this.#authority.setDeviceEnforcement(identity, {
        revision:body.revision as number,
        deviceId:LEN0,
        enabled:body.enabled as boolean,
        confirmation:body.confirmation as string,
      });
      send(response, 200, {revision, deviceId:LEN0, enabled:body.enabled});
    } catch(error) {
      if (error instanceof AuthorityError) {
        send(response, error.code === "permission_denied" ? 403 : error.code === "conflict" ? 409 : 400,
          {error:{code:error.code,message:error.message}});
      } else {
        send(response, 503, {error:{code:"authority_unavailable",message:"Owner policy action was not verified"}});
      }
    }
  }
}
