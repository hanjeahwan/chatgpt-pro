import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

/**
 * Seeds an active task through the production start journal.
 *
 * @param store Test state store.
 * @param taskId Task identifier.
 * @param sessionName Playwright session identifier.
 * @returns Nothing.
 * @throws {Error} If the task or operation conflicts.
 */
export function seedActiveTask(store: StateStore, taskId: string, sessionName: string): void {
  const operationId = `${taskId}-start-operation`;
  store.createStartingTask(taskId, sessionName, operationId);
  store.commitOperation(operationId, 'automatic');
  store.activateTask(taskId);
}
