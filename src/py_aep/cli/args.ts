import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { SystemExit } from "../../pyrt/index.ts";

/** A command's usage line, help text and options for `parseCommandLine`. */
export type Command = { prog: string; usage: string; help: string; options: ParseArgsOptionsConfig };

/** Print the usage line and `message` to stderr and exit with status 2. */
export function usageError(command: Command, message: string): never {
  console.error(command.usage.trimEnd());
  console.error(`${command.prog}: error: ${message}`);
  throw new SystemExit(2);
}

/**
 * `node:util` `parseArgs` over `argv`, with `-h`/`--help` printing the help
 * text (exit 0) and malformed input reported as a usage error (exit 2).
 */
export function parseCommandLine(command: Command, argv: string[]): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, ...command.options }, allowPositionals: true, strict: true });
  } catch (e) {
    if (e instanceof TypeError && typeof (e as { code?: unknown }).code === "string") usageError(command, e.message);
    throw e;
  }
  if (parsed.values.help) {
    console.log(command.help.trimEnd());
    throw new SystemExit(0);
  }
  return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
}

/** An option value that must be an integer. */
export function intOption(command: Command, name: string, value: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(value)) usageError(command, `argument --${name}: invalid int value: '${value}'`);
  return Number(value);
}

/** Run a CLI's `main` as the process entry point: its return value, or a `SystemExit`'s code, is the exit status. */
export function runMain(main: () => number): void {
  try {
    process.exitCode = main();
  } catch (e) {
    if (!(e instanceof SystemExit)) throw e;
    process.exitCode = typeof e.code === "number" ? e.code : e.code == null ? 0 : 1;
  }
}
