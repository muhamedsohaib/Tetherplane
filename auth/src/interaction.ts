import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";

export type TetherAuthConsentDetails = {
  missingOIDCScope?: unknown;
  missingOIDCClaims?: unknown;
  missingResourceScopes?: unknown;
  rar?: unknown;
};

export type TetherAuthInteractionDetails = {
  uid: string;
  prompt: {
    name: string;
    details?: TetherAuthConsentDetails;
  };
  params?: {
    client_id?: unknown;
  };
  session?: {
    accountId?: unknown;
  };
  grantId?: unknown;
};

export type TetherAuthInteractionResult =
  | {
      login: {
        accountId: string;
      };
    }
  | {
      consent: {
        grantId?: string;
      };
    };

export type TetherAuthInteractionProvider = {
  interactionDetails(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<TetherAuthInteractionDetails>;
  interactionFinished(
    request: IncomingMessage,
    response: ServerResponse,
    result: TetherAuthInteractionResult,
    options: {
      mergeWithLastSubmission: boolean;
    },
  ): Promise<unknown>;
};

export type TetherAuthLoginProofClient = {
  start(input: {
    interactionUid: string;
  }): Promise<{
    userCode: string;
    expiresAt: string;
  }>;
  consume(input: {
    interactionUid: string;
    userCode: string;
  }): Promise<{
    accountId: string;
  } | null>;
};

export type TetherAuthGrant = {
  addOIDCScope(scope: string): void;
  addResourceScope(
    resource: string,
    scope: string,
  ): void;
  save(): Promise<string>;
};

export type TetherAuthGrantStore = {
  find(
    grantId: string,
  ): Promise<TetherAuthGrant | null | undefined>;
  create(input: {
    accountId: string;
    clientId: string;
  }): TetherAuthGrant;
};

type ValidatedConsent = {
  interactionUid: string;
  clientId: string;
  accountId: string;
  grantId?: string;
  oidcScopes: string[];
  resourceScopes: Array<{
    resource: string;
    scopes: string[];
  }>;
};

const ALLOWED_OIDC_SCOPES = new Set([
  "openid",
  "offline_access",
]);
const ALLOWED_RESOURCE_SCOPE =
  "tetherplane:access";

export class TetherAuthInteractionController {
  readonly #provider: TetherAuthInteractionProvider;
  readonly #logins: TetherAuthLoginProofClient;
  readonly #resource: string | undefined;
  readonly #grants: TetherAuthGrantStore | undefined;

  constructor(options: {
    provider: TetherAuthInteractionProvider;
    logins: TetherAuthLoginProofClient;
    resource?: string;
    grants?: TetherAuthGrantStore;
  }) {
    this.#provider = options.provider;
    this.#logins = options.logins;
    this.#resource = options.resource;
    this.#grants = options.grants;

    if (
      (this.#resource === undefined) !==
      (this.#grants === undefined)
    ) {
      throw new Error(
        "OIDC consent requires resource and grants together",
      );
    }
    if (
      this.#resource !== undefined
    ) {
      const parsed = new URL(this.#resource);
      if (
        parsed.protocol !== "https:" ||
        parsed.pathname !== "/mcp" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error(
          "OIDC consent resource must be the canonical HTTPS /mcp URL",
        );
      }
    }
  }

  async beginLogin(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
  ): Promise<{
    userCode: string;
    expiresAt: string;
  }> {
    const details =
      await this.#validatedNamedInteraction(
        request,
        response,
        interactionUid,
        "login",
      );

    return this.#logins.start({
      interactionUid: details.uid,
    });
  }

  async completeLogin(
    request: IncomingMessage,
    response: ServerResponse,
    input: {
      interactionUid: string;
      userCode: string;
    },
  ): Promise<"pending" | "completed"> {
    const details =
      await this.#validatedNamedInteraction(
        request,
        response,
        input.interactionUid,
        "login",
      );
    validateUserCode(input.userCode);

    const proof = await this.#logins.consume({
      interactionUid: details.uid,
      userCode: input.userCode,
    });
    if (!proof) {
      return "pending";
    }
    validateAccountId(proof.accountId);

    await this.#provider.interactionFinished(
      request,
      response,
      {
        login: {
          accountId: proof.accountId,
        },
      },
      {
        mergeWithLastSubmission: false,
      },
    );

    return "completed";
  }

  async describeConsent(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
  ): Promise<{
    clientId: string;
    oidcScopes: string[];
    resourceScopes: Array<{
      resource: string;
      scopes: string[];
    }>;
  }> {
    const consent =
      await this.#validatedConsentInteraction(
        request,
        response,
        interactionUid,
      );

    return {
      clientId: consent.clientId,
      oidcScopes: [...consent.oidcScopes],
      resourceScopes:
        consent.resourceScopes.map(
          ({ resource, scopes }) => ({
            resource,
            scopes: [...scopes],
          }),
        ),
    };
  }

  async completeConsent(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
  ): Promise<"completed"> {
    const consent =
      await this.#validatedConsentInteraction(
        request,
        response,
        interactionUid,
      );
    const grants = this.#requireGrantStore();

    const existing =
      consent.grantId !== undefined;
    const grant = existing
      ? await grants.find(consent.grantId!)
      : grants.create({
          accountId: consent.accountId,
          clientId: consent.clientId,
        });
    if (!grant) {
      throw new Error(
        "OIDC consent grant is unavailable",
      );
    }

    if (consent.oidcScopes.length > 0) {
      grant.addOIDCScope(
        consent.oidcScopes.join(" "),
      );
    }
    for (
      const entry of consent.resourceScopes
    ) {
      grant.addResourceScope(
        entry.resource,
        entry.scopes.join(" "),
      );
    }

    const savedGrantId =
      await grant.save();
    if (
      typeof savedGrantId !== "string" ||
      !savedGrantId.trim()
    ) {
      throw new Error(
        "OIDC consent grant save returned an invalid identifier",
      );
    }

    await this.#provider.interactionFinished(
      request,
      response,
      {
        consent: existing
          ? {}
          : {
              grantId: savedGrantId,
            },
      },
      {
        mergeWithLastSubmission: true,
      },
    );

    return "completed";
  }

  async #validatedNamedInteraction(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
    expectedPrompt: string,
  ): Promise<TetherAuthInteractionDetails> {
    validateInteractionUid(interactionUid);

    const details =
      await this.#provider.interactionDetails(
        request,
        response,
      );

    if (
      !details ||
      typeof details.uid !== "string" ||
      details.uid !== interactionUid
    ) {
      throw new Error(
        "OIDC interaction does not match requested interaction",
      );
    }
    if (
      !details.prompt ||
      details.prompt.name !== expectedPrompt
    ) {
      throw new Error(
        `OIDC interaction is not awaiting ${expectedPrompt}`,
      );
    }

    return details;
  }

  async #validatedConsentInteraction(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
  ): Promise<ValidatedConsent> {
    const resource = this.#requireResource();
    const details =
      await this.#validatedNamedInteraction(
        request,
        response,
        interactionUid,
        "consent",
      );

    const clientId =
      details.params?.client_id;
    if (
      typeof clientId !== "string" ||
      !clientId.trim()
    ) {
      throw new Error(
        "OIDC consent client is invalid",
      );
    }

    const accountId =
      details.session?.accountId;
    if (
      typeof accountId !== "string"
    ) {
      throw new Error(
        "OIDC consent account is invalid",
      );
    }
    validateAccountId(accountId);

    const promptDetails =
      details.prompt.details ?? {};
    const oidcScopes = parseStringArray(
      promptDetails.missingOIDCScope,
      "OIDC consent scope",
    );
    if (
      oidcScopes.some(
        (scope) =>
          !ALLOWED_OIDC_SCOPES.has(scope),
      )
    ) {
      throw new Error(
        "OIDC consent requested an unsupported scope",
      );
    }

    const missingClaims =
      parseStringArray(
        promptDetails.missingOIDCClaims,
        "OIDC consent claim",
      );
    if (missingClaims.length > 0) {
      throw new Error(
        "OIDC consent claims are not supported",
      );
    }

    if (
      promptDetails.rar !== undefined
    ) {
      if (
        !Array.isArray(
          promptDetails.rar,
        ) ||
        promptDetails.rar.length > 0
      ) {
        throw new Error(
          "OIDC consent RAR is not supported",
        );
      }
    }

    const resourceScopes =
      parseResourceScopes(
        promptDetails.missingResourceScopes,
        resource,
      );

    let grantId: string | undefined;
    if (details.grantId !== undefined) {
      if (
        typeof details.grantId !== "string" ||
        !details.grantId.trim()
      ) {
        throw new Error(
          "OIDC consent grant identifier is invalid",
        );
      }
      grantId = details.grantId;
    }

    return {
      interactionUid: details.uid,
      clientId: clientId.trim(),
      accountId,
      ...(grantId
        ? { grantId }
        : {}),
      oidcScopes,
      resourceScopes,
    };
  }

  #requireResource(): string {
    if (!this.#resource) {
      throw new Error(
        "OIDC consent is not configured",
      );
    }
    return this.#resource;
  }

  #requireGrantStore(): TetherAuthGrantStore {
    if (!this.#grants) {
      throw new Error(
        "OIDC consent grants are not configured",
      );
    }
    return this.#grants;
  }
}

function parseStringArray(
  value: unknown,
  label: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item.trim(),
    )
  ) {
    throw new Error(
      `${label} list is invalid`,
    );
  }
  return value.map((item) =>
    (item as string).trim(),
  );
}

function parseResourceScopes(
  value: unknown,
  resource: string,
): Array<{
  resource: string;
  scopes: string[];
}> {
  if (value === undefined) {
    return [];
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "OIDC consent resource scopes are invalid",
    );
  }

  const output: Array<{
    resource: string;
    scopes: string[];
  }> = [];
  for (
    const [indicator, rawScopes] of
      Object.entries(value)
  ) {
    if (indicator !== resource) {
      throw new Error(
        "OIDC consent requested an unknown resource",
      );
    }
    const scopes = parseStringArray(
      rawScopes,
      "OIDC consent resource scope",
    );
    if (
      scopes.some(
        (scope) =>
          scope !==
          ALLOWED_RESOURCE_SCOPE,
      )
    ) {
      throw new Error(
        "OIDC consent requested an unsupported resource scope",
      );
    }
    if (scopes.length > 0) {
      output.push({
        resource: indicator,
        scopes,
      });
    }
  }
  return output;
}

function validateInteractionUid(
  value: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._~-]{8,256}$/.test(
      value,
    )
  ) {
    throw new Error(
      "OIDC interaction uid is invalid",
    );
  }
}

function validateUserCode(
  value: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(
      value,
    )
  ) {
    throw new Error(
      "device-login code is invalid",
    );
  }
}

function validateAccountId(
  value: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      value,
    )
  ) {
    throw new Error(
      "device-login account is invalid",
    );
  }
}
