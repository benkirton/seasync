// Test stub: await the promise with no timeout.
export class TimeoutError extends Error {}
export default async function pTimeout<T>(promise: Promise<T>): Promise<T> {
	return await promise;
}
