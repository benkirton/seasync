// Test stub: no rate limiting, just pass the function through.
export default function pThrottle(_opts: unknown) {
	return function <A extends unknown[], R>(fn: (...args: A) => R) {
		return fn;
	};
}
