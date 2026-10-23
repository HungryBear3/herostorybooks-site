import { buildDefaultConfirmationEmailSweepDeps, runConfirmationEmailSweep, type ConfirmationEmailSweepResult } from './confirmation-email-sweep.ts';

type RouteDeps = {
  runSweep: () => Promise<ConfirmationEmailSweepResult>;
};

let routeDepsOverride: RouteDeps | null = null;

export function __setConfirmationEmailSweepRouteDepsForTests(deps: Partial<RouteDeps>): void {
  routeDepsOverride = {
    runSweep: deps.runSweep ?? (() => runConfirmationEmailSweep(buildDefaultConfirmationEmailSweepDeps())),
  };
}

export function __resetConfirmationEmailSweepRouteDepsForTests(): void {
  routeDepsOverride = null;
}

export function getRouteDeps(): RouteDeps {
  if (routeDepsOverride) return routeDepsOverride;
  return {
    runSweep: () => runConfirmationEmailSweep(buildDefaultConfirmationEmailSweepDeps()),
  };
}

