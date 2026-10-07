let tail: Promise<void> = Promise.resolve();

/**
 * One in-process queue for client deletion and the writes that can add a
 * client reference. The reference scan and the delete stay on the same turn
 * of this queue, so a create cannot land between them.
 */
export function withClientReferenceLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = tail.then(operation, operation);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
