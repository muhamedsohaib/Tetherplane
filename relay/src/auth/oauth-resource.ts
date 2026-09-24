export type OAuthResource = { resource: string; issuer: string; scopes: string[] };

export function resourceMetadataUrl(oauth: OAuthResource): string {
  const resource = new URL(oauth.resource);
  return resource.origin + "/.well-known/oauth-protected-resource" + resource.pathname.replace(/\/$/, "");
}

export function validateOAuthResource(oauth: OAuthResource): OAuthResource {
  for (const value of [oauth.resource, oauth.issuer]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\s"\\]/.test(value)) {
      throw new Error("OAuth resource and issuer must be clean HTTPS URLs");
    }
  }
  if (!oauth.scopes.length || oauth.scopes.some(s => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s))) throw new Error("OAuth scopes are required");
  return structuredClone(oauth);
}

export function oauthChallenge(oauth: OAuthResource): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(oauth)}", scope="${oauth.scopes.join(" ")}"`;
}
