import type {
  FindAccount,
} from "oidc-provider";

const ACCOUNT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const findTetherAuthAccount:
  FindAccount = async (
    _ctx,
    subject,
  ) => {
    if (
      typeof subject !== "string" ||
      !ACCOUNT_ID_PATTERN.test(subject)
    ) {
      return undefined;
    }

    return {
      accountId: subject,
      async claims() {
        return {
          sub: subject,
        };
      },
    };
  };
