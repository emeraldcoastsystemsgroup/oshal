/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One image turn at a time per render bot (operator decision 2026-10-03, "Throttle image renders"). The CLI image executor (storyboard-cli-image-wiring.ts) runs every render dispatch through this in-process queue, keyed by the render bot's agent id: a bot holds one image turn at a time and the others wait in arrival order. A waiter that names `startBy` (the latest moment its render's deadline lets it begin) gives up its place when that passes, and the queue moves on to the next; a waiter that names none waits its turn however long it takes. Text turns never pass through here.
 */
/**
 * @description The in-process queue that lets each render bot run one image turn at a time.
 *
 * @module app/storyboard-image-turn-queue
 */

/** @description One render bot's line: whether its turn is taken, and who waits for it, in arrival order. */
interface BotLine {
  waiting: Array<() => void>;
}

/** @description What happened to one queued piece of work. */
export type ImageTurnOutcome<T> = { started: true; value: T; waitedMs: number } | { started: false; waitedMs: number };

/**
 * @description One image turn at a time per render bot, in arrival order. A line exists while its bot's
 * turn is taken; the turn passes straight from one holder to the next waiter, and the line is dropped
 * when nobody waits.
 */
export class ImageTurnQueue {
  private readonly lines = new Map<string, BotLine>();

  /**
   * @description Run `work` in the bot's turn: at once when the bot is free, else after the holders
   * before it. The turn is released when `work` settles, whether it resolved or threw.
   * @param {string} botId - The render bot's agent id.
   * @param {number | undefined} startBy - The latest moment (epoch ms) the work may begin; undefined waits however long it takes.
   * @param {() => Promise<T>} work - The image turn.
   * @returns {Promise<ImageTurnOutcome<T>>} Its value and how long it waited, or that it never started.
   */
  async run<T>(botId: string, startBy: number | undefined, work: () => Promise<T>): Promise<ImageTurnOutcome<T>> {
    const queuedAt = Date.now();
    if (!(await this.admit(botId, startBy))) return { started: false, waitedMs: Date.now() - queuedAt };
    const waitedMs = Date.now() - queuedAt;
    try {
      return { started: true, value: await work(), waitedMs };
    } finally {
      this.release(botId);
    }
  }

  /**
   * @description Whether the bot is holding an image turn now (tests and diagnostics).
   * @param {string} botId - The render bot's agent id.
   * @returns {boolean} True while a turn is taken.
   */
  busy(botId: string): boolean {
    return this.lines.has(botId);
  }

  /**
   * @description Take the bot's turn, or wait in line for it until `startBy`.
   * @param {string} botId - The render bot's agent id.
   * @param {number | undefined} startBy - The latest moment to begin (epoch ms), or undefined.
   * @returns {Promise<boolean>} True once the turn is this caller's, false when `startBy` passed first.
   */
  private admit(botId: string, startBy: number | undefined): Promise<boolean> {
    if (startBy !== undefined && Date.now() > startBy) return Promise.resolve(false);
    const line = this.lines.get(botId);
    if (!line) {
      this.lines.set(botId, { waiting: [] });
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const enter = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      line.waiting.push(enter);
      if (startBy === undefined) return;
      timer = setTimeout(() => {
        const at = line.waiting.indexOf(enter);
        if (at >= 0) line.waiting.splice(at, 1);
        resolve(false);
      }, Math.max(0, startBy - Date.now()));
    });
  }

  /**
   * @description Pass the bot's turn to the next waiter, or drop the line when nobody waits.
   * @param {string} botId - The render bot's agent id.
   * @returns {void}
   */
  private release(botId: string): void {
    const line = this.lines.get(botId);
    if (!line) return;
    const next = line.waiting.shift();
    if (next) next();
    else this.lines.delete(botId);
  }
}
