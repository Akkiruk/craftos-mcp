/** One `craftos-mcp <name>` subcommand. Each lives in its own file in commands/ and is found at startup. */
export interface Command {
  /** The word after `craftos-mcp`. */
  readonly name: string;
  /** One line for `craftos-mcp help`. */
  readonly summary: string;
  /** Usage lines for `craftos-mcp help <name>`. */
  readonly usage?: string;
  /** Run it; the return value is the exit code. */
  run(args: string[]): Promise<number>;
}
