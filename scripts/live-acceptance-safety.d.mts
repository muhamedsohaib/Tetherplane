export function acceptanceRootPath(
  localAppData: string,
  release: string,
): string;

export function assertFreshAcceptanceRoot(
  localAppData: string,
  release: string,
): string;

export function writeAcceptanceOwnership(
  root: string,
  release: string,
): void;

export function assertOwnedAcceptanceRoot(
  localAppData: string,
  release: string,
): string;
