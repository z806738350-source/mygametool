/** This source edition never enables arbitrary execution through environment or saved settings. */
export const LOCAL_EXECUTION_ENABLED = false;

export class LocalExecutionDisabledError extends Error {
  readonly statusCode = 403;
  constructor(feature: string) {
    super(`${feature} is temporarily unavailable in the local secure edition pending isolated execution. Static previews and project-local editing remain available.`);
    this.name = "LocalExecutionDisabledError";
  }
}

export function assertLocalExecutionAllowed(feature: string): void {
  if (!LOCAL_EXECUTION_ENABLED) throw new LocalExecutionDisabledError(feature);
}
