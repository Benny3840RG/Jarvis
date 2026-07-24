export type ControlledTaskRecord = {
  id: string;
  projectId: string;
  title: string;
  category: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  completedAt?: number;
};

export type InternalActionContext = {
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  sourceRequestId: string;
  correlationId: string;
  source: string;
};

export type CreateControlledTaskInput = InternalActionContext & {
  title: string;
  category: string;
};

export type CompleteControlledTaskInput = InternalActionContext & {
  taskId: string;
};

export interface ControlledTaskStore {
  create(input: CreateControlledTaskInput): Promise<ControlledTaskRecord>;
  complete(input: CompleteControlledTaskInput): Promise<ControlledTaskRecord | null>;
  get(projectId: string, taskId: string): Promise<ControlledTaskRecord | null>;
  cleanup(projectId: string, taskId: string): Promise<boolean>;
}
