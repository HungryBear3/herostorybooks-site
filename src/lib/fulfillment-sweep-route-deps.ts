import { buildDefaultFulfillmentSweepDeps, runFulfillmentSweep, type FulfillmentSweepResult } from './fulfillment-sweep.ts';

type RouteDeps = {
  runSweep: () => Promise<FulfillmentSweepResult>;
};

let routeDepsOverride: RouteDeps | null = null;

export function __setFulfillmentSweepRouteDepsForTests(deps: Partial<RouteDeps>): void {
  routeDepsOverride = {
    runSweep: deps.runSweep ?? (() => runFulfillmentSweep(buildDefaultFulfillmentSweepDeps())),
  };
}

export function __resetFulfillmentSweepRouteDepsForTests(): void {
  routeDepsOverride = null;
}

export function getRouteDeps(): RouteDeps {
  if (routeDepsOverride) return routeDepsOverride;
  return {
    runSweep: () => runFulfillmentSweep(buildDefaultFulfillmentSweepDeps()),
  };
}

