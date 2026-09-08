import { formatProgress, nextStage, type Stage } from './progress.js';

type Sink = {
  sendTracked(chatId: string, text: string): Promise<number>;
  edit(chatId: string, messageId: number, text: string): Promise<void>;
};

type Tracked = { messageId: number; stage: Stage };

export class ProgressTracker {
  private readonly tickets = new Map<string, Tracked>();

  constructor(
    private readonly telegram: Sink,
    private readonly chatId: string,
  ) {}

  async set(shortLink: string, title: string, stage: Stage, blocked?: string): Promise<void> {
    const known = this.tickets.get(shortLink);
    const advanced = known ? nextStage(known.stage, stage) : stage;
    if (known && advanced === known.stage && !blocked) {
      return;
    }

    const text = formatProgress({ shortLink, title, stage: advanced, blocked });
    try {
      if (!known) {
        const messageId = await this.telegram.sendTracked(this.chatId, text);
        this.tickets.set(shortLink, { messageId, stage: advanced });
      } else {
        await this.telegram.edit(this.chatId, known.messageId, text);
        this.tickets.set(shortLink, { ...known, stage: advanced });
      }
    } catch (error) {
      console.error('[fiesta] progress update failed', error);
      return;
    }

    if (advanced === 'merged') {
      this.tickets.delete(shortLink);
    }
  }

  forget(stillActive: string[]): void {
    const keep = new Set(stillActive);
    for (const shortLink of [...this.tickets.keys()]) {
      if (!keep.has(shortLink)) {
        this.tickets.delete(shortLink);
      }
    }
  }
}
