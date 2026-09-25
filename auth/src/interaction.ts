import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";

export type TetherAuthInteractionDetails = {
  uid: string;
  prompt: {
    name: string;
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
    result: {
      login: {
        accountId: string;
      };
    },
    options: {
      mergeWithLastSubmission: false;
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

export class TetherAuthInteractionController {
  readonly #provider: TetherAuthInteractionProvider;
  readonly #logins: TetherAuthLoginProofClient;

  constructor(options: {
    provider: TetherAuthInteractionProvider;
    logins: TetherAuthLoginProofClient;
  }) {
    this.#provider = options.provider;
    this.#logins = options.logins;
  }

  async beginLogin(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
  ): Promise<{
    userCode: string;
    expiresAt: string;
  }> {
    const details = await this.#validatedLoginInteraction(
      request,
      response,
      interactionUid,
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
    const details = await this.#validatedLoginInteraction(
      request,
      response,
      input.interactionUid,
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

  async #validatedLoginInteraction(
    request: IncomingMessage,
    response: ServerResponse,
    interactionUid: string,
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
      details.prompt.name !== "login"
    ) {
      throw new Error(
        "OIDC interaction is not awaiting login",
      );
    }

    return details;
  }
}

function validateInteractionUid(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._~-]{8,256}$/.test(value)
  ) {
    throw new Error(
      "OIDC interaction uid is invalid",
    );
  }
}

function validateUserCode(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)
  ) {
    throw new Error(
      "device-login code is invalid",
    );
  }
}

function validateAccountId(value: string): void {
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
