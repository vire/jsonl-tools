// argv parsing for the CLI (plan U7). Pure — no I/O — so it is unit-testable in
// isolation; cli/index.ts imports it and keeps the fs/stdin side-effects.

export interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

// Flags that never take a value. Without this, a bare boolean flag followed by a
// positional (e.g. `upload --allow-insecure run.jsonl`) would swallow the
// positional as its "value" AND fail to register as `true`.
const BOOLEAN_FLAGS = new Set(["allow-insecure"]);

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) {
        flags[name] = a.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else if (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) {
        // Consume the next token as the value. Use an index bound (not a
        // truthiness test) so an empty-string value like `--title ""` is kept
        // instead of being dropped and mis-pushed as a phantom positional.
        flags[name] = rest[++i]!;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}
