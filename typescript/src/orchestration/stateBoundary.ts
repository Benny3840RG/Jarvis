import type {
  DomainFailure,
  DomainSuccess,
  OrchestrationContext,
} from "./contracts.js";
import type { OrchestrationNode } from "./graph.js";

export type OrchestrationStepLease = {
  leaseToken: string;
};

/**
 * Durable lifecycle boundary used by the maintained runner.
 *
 * Implementations must acquire a server-issued lease before the executor is
 * called and must leave the step recoverable if either terminal write fails.
 */
export interface OrchestrationStepStateBoundary {
  start(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
  }): Promise<OrchestrationStepLease>;

  succeed(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
    leaseToken: string;
    result: DomainSuccess;
  }): Promise<void>;

  fail(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
    leaseToken: string;
    failure: DomainFailure;
  }): Promise<void>;
}
