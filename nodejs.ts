/**
 * Node.js wiring for the CLI.
 *
 * Everything that touches a Node-specific global or built-in lives here:
 * argv parsing via `node:util`, `process.stdin`/`stdout`/`stderr`, and the
 * broken-pipe handling a real command-line process needs.
 * {@link ZcapSpecExamplesCli} holds the runtime-independent behaviour.
 *
 * @module
 */

import { parseArgs, type ParseArgsConfig } from "node:util";

import {
  HELP_TEXT,
  ZcapSpecExamplesCli,
  type ZcapSpecExamplesOutputFormat,
} from "./ZcapSpecExamplesCli.ts";

// ---------------------------------------------------------------------------
// NodejsZcapSpecExamplesCli - Node.js-specific
// ---------------------------------------------------------------------------

/**
 * Config for these CLI options, in the same shape expected by Node's
 * `util.parseArgs`. Kept as a plain object literal (rather than importing
 * `node:util`'s types at the top level of the runtime-independent class)
 * so `ZcapSpecExamplesCli` above stays free of Node-specific imports.
 */
export const NODEJS_CLI_PARSE_ARGS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  url: { type: "string" },
  "base-url": { type: "string" },
  format: { type: "string" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

/**
 * @category Running the CLI
 */
export class NodejsZcapSpecExamplesCli {
  static readonly options = NODEJS_CLI_PARSE_ARGS_OPTIONS;

  private readonly proc: NodeJS.Process;
  private readonly cli: ZcapSpecExamplesCli;

  constructor(proc: NodeJS.Process) {
    this.proc = proc;

    // A downstream consumer may close the pipe before we finish writing --
    // `... | head -1`, `... | jq -e 'first(...)'`, a user quitting a pager.
    // That is normal for a CLI, so stop writing and finish quietly instead of
    // dying with an unhandled EPIPE.
    let stdoutOpen = true;
    const onStdoutError = (err: NodeJS.ErrnoException) => {
      stdoutOpen = false;
      if (err.code !== "EPIPE") {
        proc.exitCode = 1;
        try {
          proc.stderr.write(`stdout error: ${err.message}\n`);
        } catch {
          // stderr is gone too; nothing useful left to do.
        }
      }
    };
    proc.stdout.on("error", onStdoutError);

    this.cli = new ZcapSpecExamplesCli({
      fetch: (url) => globalThis.fetch(url),
      readStdin: () => readAllStdin(proc),
      writeStdout: (chunk) => {
        if (!stdoutOpen) return;
        try {
          proc.stdout.write(chunk);
        } catch {
          stdoutOpen = false;
        }
      },
      writeStderr: (chunk) => {
        try {
          proc.stderr.write(chunk);
        } catch {
          // Ignore: a closed stderr must not mask the real result.
        }
      },
    });
  }

  /** `argv` should already have the node binary and script path stripped, e.g. `process.argv.slice(2)`. */
  async run(argv: string[]): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: argv,
        options: NodejsZcapSpecExamplesCli.options,
        allowPositionals: false,
      });
    } catch (err) {
      this.proc.stderr.write(`${(err as Error).message}\n\n`);
      this.proc.stderr.write(HELP_TEXT);
      return 1;
    }

    const rawFormat = parsed.values.format as string | undefined;
    const FORMATS = ["json", "ndjson", "text"];
    if (rawFormat !== undefined && !FORMATS.includes(rawFormat)) {
      this.proc.stderr.write(
        `Invalid --format "${rawFormat}": expected ${FORMATS.map((f) => `"${f}"`).join(", ")}.\n\n`,
      );
      this.proc.stderr.write(HELP_TEXT);
      return 1;
    }

    // Pretty by default for a human at a terminal; compact NDJSON the moment
    // the output is piped or redirected, so pipelines are unaffected. This is
    // the same convention `git log` and `ls --color=auto` use.
    const format =
      (rawFormat as ZcapSpecExamplesOutputFormat | undefined) ??
      (this.proc.stdout.isTTY ? "json" : "ndjson");

    return this.cli.run({
      help: parsed.values.help as boolean | undefined,
      url: parsed.values.url as string | undefined,
      baseUrl: parsed.values["base-url"] as string | undefined,
      format,
    });
  }
}

async function readAllStdin(proc: NodeJS.Process): Promise<string | undefined> {
  if (proc.stdin.isTTY) {
    // Nothing piped in; don't block waiting for input that will never come.
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of proc.stdin) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const cli = new NodejsZcapSpecExamplesCli(globalThis.process);
  const exitCode = await cli.run(globalThis.process.argv.slice(2));
  globalThis.process.exitCode = exitCode;
}
