export type DeviceLoginProofInput = {
  interactionUid: string;
  userCode: string;
};

export type DeviceLoginProof = {
  accountId: string;
};

export type DeviceLoginProofConsumer = {
  consume(
    input: DeviceLoginProofInput,
  ): Promise<DeviceLoginProof | null>;
};

export type DeviceLoginResult = {
  accountId: string;
};

export class DeviceLoginCoordinator {
  readonly #proofs: DeviceLoginProofConsumer;

  constructor(options: {
    proofs: DeviceLoginProofConsumer;
  }) {
    if (
      !options.proofs ||
      typeof options.proofs.consume !== "function"
    ) {
      throw new Error(
        "device login requires a one-time proof consumer",
      );
    }
    this.#proofs = options.proofs;
  }

  async complete(
    input: DeviceLoginProofInput,
  ): Promise<DeviceLoginResult | null> {
    validateInteractionUid(input.interactionUid);
    validateUserCode(input.userCode);

    const proof = await this.#proofs.consume({
      interactionUid: input.interactionUid,
      userCode: input.userCode,
    });
    if (!proof) {
      return null;
    }
    if (!isValidAccountId(proof.accountId)) {
      throw new Error(
        "device login proof resolved an invalid account",
      );
    }

    return {
      accountId: proof.accountId,
    };
  }
}

function validateInteractionUid(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._~-]{8,256}$/.test(value)
  ) {
    throw new Error("interaction uid is invalid");
  }
}

function validateUserCode(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)
  ) {
    throw new Error("device login code is invalid");
  }
}

function isValidAccountId(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      value,
    )
  );
}
