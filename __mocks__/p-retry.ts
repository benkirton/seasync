// Test stub: run the operation once without retry/backoff timers.
export class AbortError extends Error {}
export default async function pRetry<T>(fn: (attempt: number) => Promise<T> | T): Promise<T> {
	return await fn(1);
}
