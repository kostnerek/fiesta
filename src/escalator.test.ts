import { describe, expect, it, vi } from 'vitest';
import { Escalator } from './escalator.js';
import type { Ticket } from './ticket.js';

const ticket: Ticket = {
  cardId: 'card-1',
  shortLink: 'aBcD1234',
  title: 'Add HELLO file',
  description: '',
  repo: 'demo',
  baseBranch: 'main',
  branch: 'fiesta/aBcD1234-add-hello-file',
};

function build(paneOutput: string, paneStatus = 'idle') {
  const herdr = {
    readPane: vi.fn().mockResolvedValue(paneOutput),
    paneStatus: vi.fn().mockResolvedValue(paneStatus),
    sendText: vi.fn(),
    findWorkspaceByLabel: vi.fn().mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' }),
  };
  const telegram = { send: vi.fn(), getUpdates: vi.fn().mockResolvedValue([]) };
  const trello = { moveCard: vi.fn(), addComment: vi.fn() };
  const escalator = new Escalator({
    herdr: herdr as never,
    telegram: telegram as never,
    trello: trello as never,
    config: {
      telegram: { chatId: '42' },
      trello: { lists: { blocked: 'list-blocked', review: 'list-review', inProgress: 'list-progress' } },
      limits: { ticketTimeoutMs: 1000 },
    } as never,
  });
  return { escalator, herdr, telegram, trello };
}

describe('Escalator.inspect', () => {
  it('moves the card to Blocked and asks on Telegram for ASK', async () => {
    const { escalator, telegram, trello } = build('@@FIESTA:ASK Which provider?\n');
    const outcome = await escalator.inspect(ticket, 'pane-1', Date.now());

    expect(outcome).toBe('blocked');
    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-blocked');
    expect(telegram.send).toHaveBeenCalledWith('42', expect.stringContaining('aBcD1234'));
  });

  it('moves the card to Review for DONE', async () => {
    const { escalator, trello } = build('@@FIESTA:DONE https://pr/7\n');
    expect(await escalator.inspect(ticket, 'pane-1', Date.now())).toBe('review');
    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-review');
  });

  it('keeps waiting while the agent is working and silent', async () => {
    const { escalator, telegram } = build('compiling...\n', 'working');
    expect(await escalator.inspect(ticket, 'pane-1', Date.now())).toBe('running');
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('fails a ticket that went quiet past the timeout', async () => {
    const { escalator, trello } = build('nothing new\n', 'idle');
    const longAgo = Date.now() - 5000;
    expect(await escalator.inspect(ticket, 'pane-1', longAgo)).toBe('blocked');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/timed out/i));
  });

  it('records the question on the card even when Telegram is down', async () => {
    const { escalator, telegram, trello } = build('@@FIESTA:ASK Which provider?\n');
    telegram.send.mockRejectedValue(new Error('telegram unreachable'));

    await expect(escalator.inspect(ticket, 'pane-1', Date.now())).rejects.toThrow(/unreachable/);

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-blocked');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringContaining('Which provider?'));
  });
});

describe('Escalator.deliverReplies', () => {
  it('routes a reply back into the pane of the matching ticket', async () => {
    const { escalator, herdr, telegram, trello } = build('');
    telegram.getUpdates.mockResolvedValue([
      {
        updateId: 5,
        chatId: '42',
        text: 'use provider X',
        replyToText: '🤖 [aBcD1234] Add HELLO file',
      },
    ]);

    await escalator.deliverReplies(new Map([['aBcD1234', { ticket, paneId: 'pane-1' }]]));

    expect(herdr.sendText).toHaveBeenCalledWith('pane-1', 'use provider X');
    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-progress');
  });

  it('ignores a reply for a ticket that is no longer running', async () => {
    const { escalator, herdr, telegram } = build('');
    telegram.getUpdates.mockResolvedValue([
      { updateId: 5, chatId: '42', text: 'hello', replyToText: '🤖 [zzzz9999] Gone' },
    ]);

    await escalator.deliverReplies(new Map());

    expect(herdr.sendText).not.toHaveBeenCalled();
  });
});
