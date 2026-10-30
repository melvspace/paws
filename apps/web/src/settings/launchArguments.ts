// Adapted from T3 Code shared/cliArgs.ts (MIT). Tokenization only; never executes a shell.
export function parseLaunchArguments(args?: string): ReadonlyArray<string> {
  const input = args?.trim();

  if (!input) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (char === undefined) continue;

    if (quote) {
      if (char === quote) {
        quote = undefined;
        quoted = true;
      } else if (char === "\\" && quote === '"') {
        const next = input[index + 1];

        if (next !== undefined && ['"', "\\", "$", "`"].includes(next)) {
          current += next;
          index++;
        } else {
          current += char;
        }
      } else {
        current += char;
      }

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (/\s/.test(char)) {
      if (current || quoted) {
        tokens.push(current);
        current = "";
        quoted = false;
      }
    } else if (char === "\\") {
      const next = input[index + 1];

      if (next !== undefined && /[\s'"]/.test(next)) {
        current += next;
        index++;
      } else {
        current += char;
      }
    } else {
      current += char;
    }
  }

  if (quote) throw new Error("Unclosed quote.");
  if (current || quoted) tokens.push(current);

  return tokens;
}

export function formatLaunchArguments(args: readonly string[]): string {
  return args
    .map((arg) =>
      /^[a-zA-Z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg),
    )
    .join(" ");
}
