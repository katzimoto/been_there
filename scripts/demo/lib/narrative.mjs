/**
 * Printing the walk as a narrative rather than as test output.
 *
 * A test prints a tick per assertion. A demonstration has to print *what it
 * observed*, because the observation is the point: "discovery returned zero
 * candidates to an unverified viewer and named no reason" is the claim, and
 * "200 OK" is not. So every step prints the value it read back, not the fact
 * that it did not throw.
 *
 * The failure shape is the other half of that. A step that throws prints which
 * number it was, what it expected and what it got, and the process exits
 * non-zero. A demo that cannot fail is a brochure, and a brochure that hides its
 * own breakage is worse than no demo.
 */
import { exit } from 'node:process';

/** Thrown by a step that could not be completed as written. */
export class StepFailure extends Error {
  constructor(index, title, reason) {
    super(`step ${index} (${title}) failed: ${reason}`);
    this.name = 'StepFailure';
    this.index = index;
    this.title = title;
    this.reason = reason;
  }
}

/** Width of the step label before the `->` column. */
const LABEL_WIDTH = 54;

/**
 * Builds the narrator. `total` is used only for the header and the closing line.
 *
 * @param {number} total
 */
export function narrator(total) {
  let index = 0;

  /** Writes one observation under the current step. */
  const say = (text) => {
    process.stdout.write(`       ${text}\n`);
  };

  return {
    say,

    heading(text) {
      process.stdout.write(`\n${text}\n`);
    },

    /**
     * Runs one step. `run` receives `say` and resolves to the one-line summary
     * that goes after the arrow.
     *
     * @param {string} title
     * @param {(say: (text: string) => void) => string | Promise<string>} run
     */
    async step(title, run) {
      index += 1;
      const label = `${index}. ${title}`;
      let summary;
      try {
        summary = await run(say);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${label.padEnd(LABEL_WIDTH)}-> REFUSED: ${reason}\n`);
        if (error instanceof StepFailure) {
          throw error;
        }
        throw new StepFailure(index, title, reason);
      }
      process.stdout.write(`${label.padEnd(LABEL_WIDTH)}-> ${summary}\n`);
      return summary;
    },

    /** Steps completed, for the closing line. */
    get completed() {
      return index;
    },
    /** Steps the run set out to complete. */
    get expected() {
      return total;
    },
  };
}

/** Prints the failure and exits non-zero, so the shell sees the same number. */
export function exitWithFailure(error) {
  process.stderr.write('\nThe journey did not complete.\n');
  if (error instanceof StepFailure) {
    process.stderr.write(`Step ${error.index} failed: ${error.reason}\n`);
  } else {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  exit(1);
}