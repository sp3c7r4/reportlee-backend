/**
 * Captures everything a request could write to a log: console.*, process.stdout.write and
 * process.stderr.write (winston may not go through console).
 */
import { vi } from "vitest";

export const captureLogs = () => {
	const lines: string[] = [];
	const push = (...args: unknown[]) => {
		lines.push(
			args
				.map((a) => {
					if (typeof a === "string") return a;
					try {
						return JSON.stringify(a);
					} catch {
						return String(a);
					}
				})
				.join(" "),
		);
	};
	const spies = [
		vi.spyOn(console, "log").mockImplementation(push),
		vi.spyOn(console, "info").mockImplementation(push),
		vi.spyOn(console, "warn").mockImplementation(push),
		vi.spyOn(console, "error").mockImplementation(push),
		vi.spyOn(console, "debug").mockImplementation(push),
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			push(String(chunk));
			return true;
		}) as typeof process.stdout.write),
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			push(String(chunk));
			return true;
		}) as typeof process.stderr.write),
	];
	return {
		text: () => lines.join("\n"),
		stop: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
};
