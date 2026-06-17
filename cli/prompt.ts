// Interactive line prompt for the CLI (plan U7/U8). Used by `login` to read a
// pasted credential from a terminal.
//
// Why not `readFileSync(0)`: a synchronous read of fd 0 on a TTY is unreliable —
// on a non-blocking terminal fd it throws EAGAIN, and elsewhere it blocks with no
// output, so `login` either crashed or looked frozen. readline drives the TTY
// correctly and lets the user finish with Enter instead of Ctrl-D. Taking the
// streams as parameters keeps this unit-testable with an in-memory PassThrough.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Write `prompt` to `output`, then resolve the first Enter-terminated line from `input`. */
export function promptLine(input: Readable, output: Writable, prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
