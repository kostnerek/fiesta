import type { TrelloCard } from './ticket.js';

export type TrelloList = { id: string; name: string };
export type TrelloBoard = { id: string; name: string };

type Credentials = { key: string; token: string };

export class TrelloClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(
    path: string,
    { method = 'GET', params = {} }: { method?: string; params?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`https://api.trello.com/1${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }

    const response = await this.fetchImpl(url.toString(), { method });
    if (!response.ok) {
      throw new Error(`Trello ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  me(): Promise<{ id: string; username: string }> {
    return this.request('/members/me');
  }

  boards(): Promise<TrelloBoard[]> {
    return this.request('/members/me/boards', { params: { fields: 'id,name' } });
  }

  createBoard(name: string): Promise<TrelloBoard> {
    return this.request('/boards', { method: 'POST', params: { name, defaultLists: 'false' } });
  }

  lists(boardId: string): Promise<TrelloList[]> {
    return this.request(`/boards/${boardId}/lists`, { params: { fields: 'id,name' } });
  }

  createList(boardId: string, name: string): Promise<TrelloList> {
    return this.request('/lists', { method: 'POST', params: { name, idBoard: boardId } });
  }

  labels(boardId: string): Promise<{ id: string; name: string }[]> {
    return this.request(`/boards/${boardId}/labels`, { params: { fields: 'id,name' } });
  }

  createLabel(boardId: string, name: string): Promise<{ id: string; name: string }> {
    return this.request('/labels', {
      method: 'POST',
      params: { name, color: 'green', idBoard: boardId },
    });
  }

  cardsInList(listId: string): Promise<TrelloCard[]> {
    return this.request(`/lists/${listId}/cards`, {
      params: { fields: 'id,shortLink,name,desc,idList', labels: 'all' },
    });
  }

  async moveCard(cardId: string, listId: string): Promise<void> {
    await this.request(`/cards/${cardId}`, { method: 'PUT', params: { idList: listId } });
  }

  async addComment(cardId: string, text: string): Promise<void> {
    await this.request(`/cards/${cardId}/actions/comments`, { method: 'POST', params: { text } });
  }
}
