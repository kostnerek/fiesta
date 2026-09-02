# Fiesta — plan implementacji MVP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Karta wrzucona do kolumny `Ready` na Trello powoduje powstanie draft PR-a bez udziału człowieka, a agent, który czegoś nie może ustalić sam, pinguje Telegram i czeka na odpowiedź.

**Architecture:** Bezstanowy daemon w TypeScript odpytuje Trello, zajmuje kartę przenosząc ją do `In Progress`, klonuje repo do izolowanego katalogu, startuje Claude Code w kontenerze wewnątrz panelu herdr i nasłuchuje markerów `@@FIESTA:` w wyjściu panelu. Stan żyje na boardzie i w herdr — daemon nie prowadzi własnej bazy.

**Tech Stack:** Node 22, TypeScript, pnpm, vitest, `undici`/`fetch` do HTTP, `@inquirer/prompts` do kreatora, Docker, herdr CLI.

**Spec:** `docs/superpowers/specs/2026-09-02-fiesta-agent-farm-design.md`

## Global Constraints

- Node >= 22, pnpm, ESM (`"type": "module"`), TypeScript strict.
- Testy w vitest, pliki `*.test.ts` obok źródła.
- **Zero stanu na dysku poza `.env`.** Prawdą o ticketach jest board, o panelach herdr. Żadnej bazy, żadnego pliku z listą przetworzonych kart.
- Kolumny: `Backlog`, `Ready`, `In Progress`, `Blocked`, `Review`, `Done`. Id list rozwiązane raz przez setup i trzymane w `.env` — nigdy nie szukamy listy po nazwie w czasie działania.
- Markery: dokładnie `@@FIESTA:ASK`, `@@FIESTA:DONE`, `@@FIESTA:FAIL`.
- Nazwa gałęzi: `fiesta/<shortLink>-<slug>`.
- `MAX_ACTIVE` domyślnie `1`, `TICKET_TIMEOUT` 60 min, `POLL_INTERVAL` 30 s.
- Korzeń danych: `/mnt/user/appdata/fiesta`.
- Bez komentarzy w kodzie — jeśli coś wymaga wyjaśnienia, zmień nazwę albo wydziel funkcję.

---

### Task 1: Szkielet projektu i konfiguracja

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `type Config`, `type ColumnName`, `loadConfig(env: NodeJS.ProcessEnv): Config`

- [ ] **Step 1: Scaffold projektu**

```bash
cd ~/repos/mine/fiesta
pnpm init
pnpm add undici @inquirer/prompts
pnpm add -D typescript vitest @types/node tsx
```

`package.json` — ustaw `"type": "module"` i skrypty:

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "setup": "tsx src/setup.ts",
    "start": "tsx src/main.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules
.env
dist
```

- [ ] **Step 2: Napisz failujący test konfiguracji**

`src/config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const complete = {
  TRELLO_API_KEY: 'k',
  TRELLO_TOKEN: 't',
  TRELLO_BOARD_ID: 'b',
  TRELLO_LIST_BACKLOG: 'l1',
  TRELLO_LIST_READY: 'l2',
  TRELLO_LIST_IN_PROGRESS: 'l3',
  TRELLO_LIST_BLOCKED: 'l4',
  TRELLO_LIST_REVIEW: 'l5',
  TRELLO_LIST_DONE: 'l6',
  TELEGRAM_BOT_TOKEN: 'tg',
  TELEGRAM_CHAT_ID: '123',
  GITHUB_TOKEN: 'gh',
  GITHUB_OWNER: 'kostnerek',
  FIESTA_ROOT: '/tmp/fiesta',
  CLAUDE_CREDENTIALS_PATH: '/home/x/.claude',
};

describe('loadConfig', () => {
  it('maps every list id onto a named column', () => {
    const config = loadConfig(complete);
    expect(config.trello.lists.ready).toBe('l2');
    expect(config.trello.lists.inProgress).toBe('l3');
  });

  it('applies defaults for optional limits', () => {
    const config = loadConfig(complete);
    expect(config.limits.maxActive).toBe(1);
    expect(config.limits.ticketTimeoutMs).toBe(60 * 60 * 1000);
    expect(config.limits.pollIntervalMs).toBe(30 * 1000);
  });

  it('names every missing variable in one error', () => {
    expect(() => loadConfig({ TRELLO_API_KEY: 'k' })).toThrowError(
      /TRELLO_TOKEN.*TELEGRAM_BOT_TOKEN/s,
    );
  });
});
```

Ostatni test jest istotny: kreator i daemon uruchamiają się bez człowieka przy klawiaturze, więc konfiguracja ma zgłaszać **wszystkie** braki naraz, a nie pierwszy z brzegu.

- [ ] **Step 3: Uruchom test — ma failować**

Run: `pnpm vitest run src/config.test.ts`
Expected: FAIL — `Failed to resolve import "./config.js"`

- [ ] **Step 4: Zaimplementuj konfigurację**

`src/config.ts`:

```typescript
export type ColumnName = 'backlog' | 'ready' | 'inProgress' | 'blocked' | 'review' | 'done';

export type Config = {
  trello: { key: string; token: string; boardId: string; lists: Record<ColumnName, string> };
  telegram: { botToken: string; chatId: string };
  github: { token: string; owner: string };
  paths: { root: string; claudeCredentials: string };
  limits: { maxActive: number; ticketTimeoutMs: number; pollIntervalMs: number };
};

const LIST_VARS: Record<ColumnName, string> = {
  backlog: 'TRELLO_LIST_BACKLOG',
  ready: 'TRELLO_LIST_READY',
  inProgress: 'TRELLO_LIST_IN_PROGRESS',
  blocked: 'TRELLO_LIST_BLOCKED',
  review: 'TRELLO_LIST_REVIEW',
  done: 'TRELLO_LIST_DONE',
};

const REQUIRED = [
  'TRELLO_API_KEY',
  'TRELLO_TOKEN',
  'TRELLO_BOARD_ID',
  ...Object.values(LIST_VARS),
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'FIESTA_ROOT',
  'CLAUDE_CREDENTIALS_PATH',
];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(', ')}. Run "pnpm setup".`);
  }

  const lists = Object.fromEntries(
    Object.entries(LIST_VARS).map(([column, variable]) => [column, env[variable] as string]),
  ) as Record<ColumnName, string>;

  return {
    trello: {
      key: env.TRELLO_API_KEY as string,
      token: env.TRELLO_TOKEN as string,
      boardId: env.TRELLO_BOARD_ID as string,
      lists,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN as string,
      chatId: env.TELEGRAM_CHAT_ID as string,
    },
    github: { token: env.GITHUB_TOKEN as string, owner: env.GITHUB_OWNER as string },
    paths: {
      root: env.FIESTA_ROOT as string,
      claudeCredentials: env.CLAUDE_CREDENTIALS_PATH as string,
    },
    limits: {
      maxActive: Number(env.MAX_ACTIVE ?? 1),
      ticketTimeoutMs: Number(env.TICKET_TIMEOUT_MIN ?? 60) * 60 * 1000,
      pollIntervalMs: Number(env.POLL_INTERVAL_SEC ?? 30) * 1000,
    },
  };
}
```

- [ ] **Step 5: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/config.test.ts`
Expected: PASS (3 testy)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore src/config.ts src/config.test.ts
git commit -m "Add project scaffold and typed configuration loader"
```

---

### Task 2: Parser markerów

Serce protokołu eskalacji. Czysta funkcja, zero I/O.

**Files:**
- Create: `src/markers.ts`
- Test: `src/markers.test.ts`

**Interfaces:**
- Produces: `type Marker = { kind: 'ASK' | 'DONE' | 'FAIL'; text: string }`, `findLastMarker(paneOutput: string): Marker | null`

- [ ] **Step 1: Napisz failujące testy**

`src/markers.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { findLastMarker } from './markers.js';

describe('findLastMarker', () => {
  it('returns null when the output has no marker', () => {
    expect(findLastMarker('running tests...\nall green\n')).toBeNull();
  });

  it('extracts the marker kind and its text', () => {
    const output = 'work\n@@FIESTA:ASK Which payment provider should I wire up?\n';
    expect(findLastMarker(output)).toEqual({
      kind: 'ASK',
      text: 'Which payment provider should I wire up?',
    });
  });

  it('returns the last marker when several are present', () => {
    const output = '@@FIESTA:ASK first question\nanswer given\n@@FIESTA:DONE https://pr/1\n';
    expect(findLastMarker(output)).toEqual({ kind: 'DONE', text: 'https://pr/1' });
  });

  it('ignores a marker quoted inside the prompt echo', () => {
    const output = 'End your turn with "@@FIESTA:ASK <question>" when blocked.\n';
    expect(findLastMarker(output)).toBeNull();
  });

  it('accepts a marker with no trailing text', () => {
    expect(findLastMarker('@@FIESTA:FAIL\n')).toEqual({ kind: 'FAIL', text: '' });
  });
});
```

Czwarty test jest tu najważniejszy. Prompt startowy **zawiera instrukcję o markerach**, więc jego echo pojawi się w wyjściu panelu. Parser, który go złapie, zgłosi eskalację w sekundę po starcie agenta — zanim ten cokolwiek zrobi. Marker liczy się wyłącznie na początku linii.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/markers.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/markers.ts`:

```typescript
export type MarkerKind = 'ASK' | 'DONE' | 'FAIL';

export type Marker = { kind: MarkerKind; text: string };

const MARKER_LINE = /^@@FIESTA:(ASK|DONE|FAIL)[ \t]*(.*)$/;

export function findLastMarker(paneOutput: string): Marker | null {
  const lines = paneOutput.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = MARKER_LINE.exec(lines[index] ?? '');
    if (match) {
      return { kind: match[1] as MarkerKind, text: (match[2] ?? '').trim() };
    }
  }
  return null;
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/markers.test.ts`
Expected: PASS (5 testów)

- [ ] **Step 5: Commit**

```bash
git add src/markers.ts src/markers.test.ts
git commit -m "Add marker parser for the agent escalation protocol"
```

---

### Task 3: Odczyt ticketu z karty

**Files:**
- Create: `src/ticket.ts`
- Test: `src/ticket.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: `type TrelloCard`, `type Ticket`, `toTicket(card: TrelloCard): Ticket`, `class TicketError extends Error`

- [ ] **Step 1: Napisz failujące testy**

`src/ticket.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { TicketError, toTicket, type TrelloCard } from './ticket.js';

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'card-1',
    shortLink: 'aBcD1234',
    name: 'Add HELLO file',
    desc: 'Create HELLO.md at the repo root.',
    labels: [{ id: 'lab-1', name: 'fiesta' }],
    idList: 'list-ready',
    ...overrides,
  };
}

describe('toTicket', () => {
  it('takes the repo from the single label', () => {
    expect(toTicket(makeCard()).repo).toBe('fiesta');
  });

  it('defaults the base branch to main', () => {
    expect(toTicket(makeCard()).baseBranch).toBe('main');
  });

  it('reads an explicit base branch from the description', () => {
    const card = makeCard({ desc: 'base: develop\n\nDo the thing.' });
    expect(toTicket(card).baseBranch).toBe('develop');
  });

  it('builds a deterministic branch name from shortLink and title', () => {
    const card = makeCard({ name: 'Add HELLO file, please!' });
    expect(toTicket(card).branch).toBe('fiesta/aBcD1234-add-hello-file-please');
  });

  it('rejects a card with no label', () => {
    expect(() => toTicket(makeCard({ labels: [] }))).toThrow(TicketError);
  });

  it('rejects a card with more than one label', () => {
    const card = makeCard({
      labels: [
        { id: 'a', name: 'fiesta' },
        { id: 'b', name: 'trader' },
      ],
    });
    expect(() => toTicket(card)).toThrow(TicketError);
  });
});
```

Dwa ostatnie testy chronią przed najgorszym trybem awarii: kartą bez repo albo z dwoma, przy której agent wystartowałby w losowym projekcie. Karta nie do odczytania ma trafić do `Blocked` z czytelnym komentarzem, nie do zgadywania.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/ticket.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/ticket.ts`:

```typescript
export type TrelloLabel = { id: string; name: string };

export type TrelloCard = {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  labels: TrelloLabel[];
  idList: string;
};

export type Ticket = {
  cardId: string;
  shortLink: string;
  title: string;
  description: string;
  repo: string;
  baseBranch: string;
  branch: string;
};

export class TicketError extends Error {}

const BASE_BRANCH_LINE = /^base:[ \t]*(\S+)[ \t]*$/m;
const MAX_SLUG_LENGTH = 40;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

export function toTicket(card: TrelloCard): Ticket {
  if (card.labels.length !== 1) {
    throw new TicketError(
      `Card "${card.name}" needs exactly one label naming the repository, found ${card.labels.length}.`,
    );
  }

  const repo = card.labels[0]!.name;
  const baseBranch = BASE_BRANCH_LINE.exec(card.desc)?.[1] ?? 'main';

  return {
    cardId: card.id,
    shortLink: card.shortLink,
    title: card.name,
    description: card.desc,
    repo,
    baseBranch,
    branch: `fiesta/${card.shortLink}-${slugify(card.name)}`,
  };
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/ticket.test.ts`
Expected: PASS (6 testów)

- [ ] **Step 5: Commit**

```bash
git add src/ticket.ts src/ticket.test.ts
git commit -m "Add Trello card to ticket mapping with strict repo label rules"
```

---

### Task 4: Klient Trello

**Files:**
- Create: `src/trello.ts`
- Test: `src/trello.test.ts`

**Interfaces:**
- Consumes: `TrelloCard` z `src/ticket.ts`
- Produces: `class TrelloClient` z metodami `me()`, `boards()`, `createBoard(name)`, `lists(boardId)`, `createList(boardId, name)`, `cardsInList(listId)`, `moveCard(cardId, listId)`, `addComment(cardId, text)`

- [ ] **Step 1: Przechwyć prawdziwy kształt karty**

Nie pisz parsera przeciwko wyobrażonemu API. Zrób jedną kartę na boardzie testowym i zapisz surową odpowiedź:

```bash
mkdir -p test/fixtures
curl -s "https://api.trello.com/1/lists/<LIST_ID>/cards?key=<KEY>&token=<TOKEN>" \
  | tee test/fixtures/trello-cards.json | head -40
```

Porównaj nazwy pól z `TrelloCard` z Taska 3 (`id`, `shortLink`, `name`, `desc`, `labels[].name`, `idList`). Jeśli którakolwiek się różni — popraw typ w `src/ticket.ts` i jego testy, zanim ruszysz dalej.

- [ ] **Step 2: Napisz failujące testy**

`src/trello.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrelloClient } from './trello.js';

function makeClient(fetchImpl: typeof fetch) {
  return new TrelloClient({ key: 'k', token: 't' }, fetchImpl);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TrelloClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends credentials to every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    await makeClient(fetchMock).cardsInList('list-1');
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/1/lists/list-1/cards');
    expect(url.searchParams.get('key')).toBe('k');
    expect(url.searchParams.get('token')).toBe('t');
  });

  it('moves a card with a PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    await makeClient(fetchMock).moveCard('card-1', 'list-2');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get('idList')).toBe('list-2');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('throws with the response body when the API rejects the call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid token', { status: 401 }));
    await expect(makeClient(fetchMock).me()).rejects.toThrow(/401.*invalid token/s);
  });
});
```

Trzeci test istnieje, bo daemon działa bez nadzoru: `401` po wygaśnięciu tokenu musi zostawić w logu treść odpowiedzi, a nie samo `fetch failed`.

- [ ] **Step 3: Uruchom test — ma failować**

Run: `pnpm vitest run src/trello.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 4: Zaimplementuj**

`src/trello.ts`:

```typescript
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
    return this.request('/lists', { method: 'POST', params: { name, idList: '', idBoard: boardId } });
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
```

- [ ] **Step 5: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/trello.test.ts`
Expected: PASS (3 testy)

- [ ] **Step 6: Commit**

```bash
git add src/trello.ts src/trello.test.ts test/fixtures/trello-cards.json
git commit -m "Add Trello REST client with credential injection and loud failures"
```

---

### Task 5: Wrapper na CLI herdr

**Files:**
- Create: `src/herdr.ts`
- Test: `src/herdr.test.ts`
- Create: `test/fixtures/herdr/*.json` (przechwycone w kroku 1)

**Interfaces:**
- Produces: `type PaneStatus`, `type HerdrWorkspace`, `class HerdrClient` z `createWorkspace(label, cwd)`, `findWorkspaceByLabel(label)`, `startAgent({ workspaceId, name, command })`, `readPane(paneId)`, `paneStatus(paneId)`, `sendText(paneId, text)`, `killWorkspace(workspaceId)`

- [ ] **Step 1: Przechwyć prawdziwy output herdr**

Kluczowy krok tego zadania — schemat JSON-a nie jest znany z góry:

```bash
mkdir -p test/fixtures/herdr
herdr workspace create --cwd /tmp --label probe --json | tee test/fixtures/herdr/workspace-create.json
herdr workspace list --json                            | tee test/fixtures/herdr/workspace-list.json
herdr pane list --json                                 | tee test/fixtures/herdr/pane-list.json
herdr pane get <PANE_ID> --json                        | tee test/fixtures/herdr/pane-get.json
```

Zanotuj rzeczywiste nazwy pól (id workspace'a, id panelu, pole statusu) i użyj ich w typach poniżej. Jeśli któraś komenda nie przyjmuje `--json`, sprawdź `herdr <komenda> --help` i zapisz faktyczny format. **Nie zgaduj.**

- [ ] **Step 2: Napisz failujące testy**

`src/herdr.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { HerdrClient } from './herdr.js';

describe('HerdrClient', () => {
  it('creates a workspace with the label and cwd', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ id: 'ws-1', label: 'aBcD1234' }));
    const client = new HerdrClient(run);

    const workspace = await client.createWorkspace('aBcD1234', '/work/aBcD1234');

    expect(workspace).toEqual({ id: 'ws-1', label: 'aBcD1234' });
    expect(run).toHaveBeenCalledWith([
      'workspace', 'create', '--cwd', '/work/aBcD1234', '--label', 'aBcD1234', '--json',
    ]);
  });

  it('finds a workspace by label', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify([{ id: 'ws-1', label: 'other' }, { id: 'ws-2', label: 'aBcD1234' }]),
    );
    await expect(new HerdrClient(run).findWorkspaceByLabel('aBcD1234')).resolves.toEqual({
      id: 'ws-2',
      label: 'aBcD1234',
    });
  });

  it('returns null when no workspace carries the label', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([]));
    await expect(new HerdrClient(run).findWorkspaceByLabel('nope')).resolves.toBeNull();
  });

  it('sends text verbatim to a pane', async () => {
    const run = vi.fn().mockResolvedValue('');
    await new HerdrClient(run).sendText('pane-1', 'use provider X');
    expect(run).toHaveBeenCalledWith(['pane', 'send-text', 'pane-1', 'use provider X']);
  });
});
```

- [ ] **Step 3: Uruchom test — ma failować**

Run: `pnpm vitest run src/herdr.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 4: Zaimplementuj**

`src/herdr.ts` — dostosuj nazwy pól do fixtures z kroku 1:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type HerdrWorkspace = { id: string; label: string };

export type HerdrRunner = (args: string[]) => Promise<string>;

const defaultRunner: HerdrRunner = async (args) => {
  const { stdout } = await execFileAsync('herdr', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

export class HerdrClient {
  constructor(private readonly run: HerdrRunner = defaultRunner) {}

  private async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.run(args)) as T;
  }

  createWorkspace(label: string, cwd: string): Promise<HerdrWorkspace> {
    return this.json(['workspace', 'create', '--cwd', cwd, '--label', label, '--json']);
  }

  async findWorkspaceByLabel(label: string): Promise<HerdrWorkspace | null> {
    const workspaces = await this.json<HerdrWorkspace[]>(['workspace', 'list', '--json']);
    return workspaces.find((workspace) => workspace.label === label) ?? null;
  }

  async startAgent(params: { workspaceId: string; name: string; command: string }): Promise<string> {
    const pane = await this.json<{ id: string }>([
      'pane', 'create', '--workspace', params.workspaceId, '--json',
    ]);
    await this.run(['pane', 'run', pane.id, params.command]);
    return pane.id;
  }

  readPane(paneId: string): Promise<string> {
    return this.run(['pane', 'read', paneId, '--source', 'recent-unwrapped']);
  }

  async paneStatus(paneId: string): Promise<PaneStatus> {
    const pane = await this.json<{ status?: PaneStatus }>(['pane', 'get', paneId, '--json']);
    return pane.status ?? 'unknown';
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await this.run(['pane', 'send-text', paneId, text]);
  }

  async killWorkspace(workspaceId: string): Promise<void> {
    await this.run(['workspace', 'kill', workspaceId]);
  }
}
```

- [ ] **Step 5: Uruchom testy i zweryfikuj wrapper na żywym herdr**

```bash
pnpm vitest run src/herdr.test.ts
pnpm tsx -e "import {HerdrClient} from './src/herdr.js'; const h=new HerdrClient(); console.log(await h.findWorkspaceByLabel('probe'));"
```

Expected: testy PASS, a wywołanie na żywo zwraca workspace `probe` z kroku 1. Jeśli zwróci `null` mimo istniejącego workspace'a — nazwy pól w fixtures nie zgadzają się z typami; popraw je teraz.

- [ ] **Step 6: Posprzątaj i zacommituj**

```bash
herdr workspace kill <PROBE_WORKSPACE_ID>
git add src/herdr.ts src/herdr.test.ts test/fixtures/herdr
git commit -m "Add herdr CLI wrapper verified against captured real output"
```

---

### Task 6: Przygotowanie katalogu roboczego

**Files:**
- Create: `src/workspace.ts`
- Test: `src/workspace.test.ts`

**Interfaces:**
- Consumes: `Ticket` z `src/ticket.ts`
- Produces: `ensureMirror({ root, owner, repo, token })`, `prepareWorkspace({ root, mirrorPath, ticket })`, `removeWorkspace({ root, shortLink })`

- [ ] **Step 1: Napisz failujące testy**

Testy pracują na prawdziwym gicie w katalogu tymczasowym — szybkie i deterministyczne, bez sieci.

`src/workspace.test.ts`:

```typescript
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareWorkspace } from './workspace.js';
import type { Ticket } from './ticket.js';

const run = promisify(execFile);

let root: string;
let mirrorPath: string;

const ticket: Ticket = {
  cardId: 'card-1',
  shortLink: 'aBcD1234',
  title: 'Add HELLO file',
  description: '',
  repo: 'demo',
  baseBranch: 'main',
  branch: 'fiesta/aBcD1234-add-hello-file',
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fiesta-'));
  mirrorPath = join(root, 'repos', 'demo');
  await run('git', ['init', '--initial-branch=main', mirrorPath]);
  await writeFile(join(mirrorPath, 'README.md'), 'demo\n');
  await run('git', ['-C', mirrorPath, 'add', '.']);
  await run('git', ['-C', mirrorPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
});

describe('prepareWorkspace', () => {
  it('clones the mirror and checks out the ticket branch', async () => {
    const path = await prepareWorkspace({ root, mirrorPath, ticket });

    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('demo\n');
    const { stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('fiesta/aBcD1234-add-hello-file');
  });

  it('is idempotent — a second call reuses the same checkout', async () => {
    const first = await prepareWorkspace({ root, mirrorPath, ticket });
    await writeFile(join(first, 'scratch.txt'), 'kept\n');
    const second = await prepareWorkspace({ root, mirrorPath, ticket });

    expect(second).toBe(first);
    expect(await readFile(join(second, 'scratch.txt'), 'utf8')).toBe('kept\n');
  });
});
```

Drugi test wprost koduje decyzję ze specu: po restarcie karta wraca do `Ready` i leci jeszcze raz, ale nazwa gałęzi jest deterministyczna, więc trafia w ten sam katalog zamiast mnożyć śmieci.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/workspace.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/workspace.ts`:

```typescript
import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Ticket } from './ticket.js';

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureMirror(params: {
  root: string;
  owner: string;
  repo: string;
  token: string;
}): Promise<string> {
  const mirrorPath = join(params.root, 'repos', params.repo);
  const remote = `https://x-access-token:${params.token}@github.com/${params.owner}/${params.repo}.git`;

  if (await exists(mirrorPath)) {
    await git(['-C', mirrorPath, 'fetch', '--prune', 'origin']);
    return mirrorPath;
  }

  await mkdir(join(params.root, 'repos'), { recursive: true });
  await git(['clone', remote, mirrorPath]);
  return mirrorPath;
}

export async function prepareWorkspace(params: {
  root: string;
  mirrorPath: string;
  ticket: Ticket;
}): Promise<string> {
  const workspacePath = join(params.root, 'work', params.ticket.shortLink);
  if (await exists(workspacePath)) {
    return workspacePath;
  }

  await mkdir(join(params.root, 'work'), { recursive: true });
  await git(['clone', '--local', params.mirrorPath, workspacePath]);
  await git(['-C', workspacePath, 'checkout', '-B', params.ticket.branch, params.ticket.baseBranch]);
  return workspacePath;
}

export async function removeWorkspace(params: { root: string; shortLink: string }): Promise<void> {
  await rm(join(params.root, 'work', params.shortLink), { recursive: true, force: true });
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/workspace.test.ts`
Expected: PASS (2 testy)

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts src/workspace.test.ts
git commit -m "Add on-demand repo mirror and isolated per-ticket checkout"
```

---

### Task 7: Klient GitHub

**Files:**
- Create: `src/github.ts`
- Test: `src/github.test.ts`

**Interfaces:**
- Produces: `class GitHubClient` z `user()`, `createDraftPr({ repo, title, head, base, body })`, `findPrByBranch(repo, branch)`; typ `PullRequest = { number: number; url: string; merged: boolean }`

- [ ] **Step 1: Napisz failujące testy**

`src/github.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './github.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHubClient', () => {
  it('opens the pull request as a draft', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ number: 7, html_url: 'https://pr/7', merged: false }));
    const client = new GitHubClient({ token: 'gh', owner: 'kostnerek' }, fetchMock);

    const pr = await client.createDraftPr({
      repo: 'demo',
      title: 'Add HELLO file',
      head: 'fiesta/aBcD1234-add-hello-file',
      base: 'main',
      body: 'Assumptions: none',
    });

    expect(pr).toEqual({ number: 7, url: 'https://pr/7', merged: false });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.draft).toBe(true);
  });

  it('finds the pull request for a branch without stored state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ number: 7, html_url: 'https://pr/7', merged_at: '2026-09-02T10:00:00Z' }]));
    const client = new GitHubClient({ token: 'gh', owner: 'kostnerek' }, fetchMock);

    const pr = await client.findPrByBranch('demo', 'fiesta/aBcD1234-add-hello-file');

    expect(pr).toEqual({ number: 7, url: 'https://pr/7', merged: true });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('head')).toBe('kostnerek:fiesta/aBcD1234-add-hello-file');
    expect(url.searchParams.get('state')).toBe('all');
  });

  it('returns null when the branch has no pull request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new GitHubClient({ token: 'gh', owner: 'kostnerek' }, fetchMock);
    await expect(client.findPrByBranch('demo', 'nope')).resolves.toBeNull();
  });
});
```

Wyszukiwanie PR-a **po gałęzi**, a nie po zapamiętanym numerze, jest tym, co pozwala pollerowi wykrywać merge bez trzymania jakiegokolwiek stanu — gałąź wyprowadzamy z karty.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/github.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/github.ts`:

```typescript
export type PullRequest = { number: number; url: string; merged: boolean };

type Credentials = { token: string; owner: string };

type PullRequestPayload = {
  number: number;
  html_url: string;
  merged?: boolean;
  merged_at?: string | null;
};

export class GitHubClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.credentials.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  user(): Promise<{ login: string }> {
    return this.request('/user');
  }

  async createDraftPr(params: {
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<PullRequest> {
    const payload = await this.request<PullRequestPayload>(
      `/repos/${this.credentials.owner}/${params.repo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: params.title,
          head: params.head,
          base: params.base,
          body: params.body,
          draft: true,
        }),
      },
    );
    return toPullRequest(payload);
  }

  async findPrByBranch(repo: string, branch: string): Promise<PullRequest | null> {
    const query = new URLSearchParams({
      head: `${this.credentials.owner}:${branch}`,
      state: 'all',
    });
    const payloads = await this.request<PullRequestPayload[]>(
      `/repos/${this.credentials.owner}/${repo}/pulls?${query.toString()}`,
    );
    const payload = payloads[0];
    return payload ? toPullRequest(payload) : null;
  }
}

function toPullRequest(payload: PullRequestPayload): PullRequest {
  return {
    number: payload.number,
    url: payload.html_url,
    merged: payload.merged === true || Boolean(payload.merged_at),
  };
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/github.test.ts`
Expected: PASS (3 testy)

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "Add GitHub client for draft PRs and stateless merge detection"
```

---

### Task 8: Klient Telegram

**Files:**
- Create: `src/telegram.ts`
- Test: `src/telegram.test.ts`

**Interfaces:**
- Produces: `class TelegramClient` z `getMe()`, `send(chatId, text)`, `getUpdates(offset)`; `type TelegramUpdate = { updateId: number; chatId: string; text: string; replyToText: string | null }`; `formatEscalation({ shortLink, title, marker })`; `extractShortLink(text)`

- [ ] **Step 1: Napisz failujące testy**

`src/telegram.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { extractShortLink, formatEscalation, TelegramClient } from './telegram.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('formatEscalation', () => {
  it('puts the shortLink where extractShortLink can find it again', () => {
    const text = formatEscalation({
      shortLink: 'aBcD1234',
      title: 'Add HELLO file',
      marker: { kind: 'ASK', text: 'Which provider?' },
    });
    expect(extractShortLink(text)).toBe('aBcD1234');
    expect(text).toContain('Which provider?');
  });

  it('asks for a reply only for ASK', () => {
    const ask = formatEscalation({
      shortLink: 'a1',
      title: 't',
      marker: { kind: 'ASK', text: 'q' },
    });
    const fail = formatEscalation({
      shortLink: 'a1',
      title: 't',
      marker: { kind: 'FAIL', text: 'tests red' },
    });
    expect(ask).toMatch(/odpowiedz/i);
    expect(fail).not.toMatch(/odpowiedz/i);
  });
});

describe('extractShortLink', () => {
  it('returns null when the message carries no shortLink', () => {
    expect(extractShortLink('just chatting')).toBeNull();
  });
});

describe('TelegramClient', () => {
  it('normalises an update, keeping the replied-to text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 11,
            message: {
              chat: { id: 42 },
              text: 'use provider X',
              reply_to_message: { text: '🤖 [aBcD1234] Add HELLO file' },
            },
          },
        ],
      }),
    );
    const updates = await new TelegramClient('token', fetchMock).getUpdates(10);
    expect(updates).toEqual([
      {
        updateId: 11,
        chatId: '42',
        text: 'use provider X',
        replyToText: '🤖 [aBcD1234] Add HELLO file',
      },
    ]);
  });

  it('drops updates that are not replies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: [{ update_id: 12, message: { chat: { id: 42 }, text: 'hi' } }] }),
    );
    const updates = await new TelegramClient('token', fetchMock).getUpdates(10);
    expect(updates[0]!.replyToText).toBeNull();
  });
});
```

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/telegram.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/telegram.ts`:

```typescript
import type { Marker } from './markers.js';

export type TelegramUpdate = {
  updateId: number;
  chatId: string;
  text: string;
  replyToText: string | null;
};

const SHORT_LINK = /\[([A-Za-z0-9]{6,})\]/;

export function extractShortLink(text: string): string | null {
  return SHORT_LINK.exec(text)?.[1] ?? null;
}

export function formatEscalation(params: {
  shortLink: string;
  title: string;
  marker: Marker;
}): string {
  const header = `🤖 [${params.shortLink}] ${params.title}`;
  if (params.marker.kind === 'ASK') {
    return `${header}\n\n❓ ${params.marker.text}\n\nOdpowiedz na tę wiadomość, żeby odblokować agenta.`;
  }
  if (params.marker.kind === 'FAIL') {
    return `${header}\n\n🛑 Zatrzymany: ${params.marker.text}`;
  }
  return `${header}\n\n✅ Draft PR: ${params.marker.text}`;
}

export class TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://api.telegram.org/bot${this.botToken}/${method}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const response = await this.fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!payload.ok) {
      throw new Error(`Telegram ${method} rejected: ${payload.description ?? 'unknown error'}`);
    }
    return payload.result;
  }

  getMe(): Promise<{ username: string }> {
    return this.request('getMe', {});
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.request('sendMessage', { chat_id: chatId, text });
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const raw = await this.request<
      { update_id: number; message?: { chat: { id: number }; text?: string; reply_to_message?: { text?: string } } }[]
    >('getUpdates', { offset: String(offset), timeout: '0' });

    return raw
      .filter((update) => update.message?.text)
      .map((update) => ({
        updateId: update.update_id,
        chatId: String(update.message!.chat.id),
        text: update.message!.text!,
        replyToText: update.message!.reply_to_message?.text ?? null,
      }));
  }
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/telegram.test.ts`
Expected: PASS (5 testów)

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts src/telegram.test.ts
git commit -m "Add Telegram client with shortLink-addressed escalation messages"
```

---

### Task 9: Kreator `fiesta setup`

**Files:**
- Create: `src/setup.ts`
- Create: `src/setup-steps.ts`
- Test: `src/setup-steps.test.ts`

**Interfaces:**
- Consumes: `TrelloClient`, `TelegramClient`, `GitHubClient`
- Produces: `ensureColumns(trello, boardId)`, `detectChatId(telegram, sinceOffset)`, `renderEnvFile(values)`

Logika testowalna idzie do `setup-steps.ts`; `setup.ts` to sam dialog i sklejenie kroków.

- [ ] **Step 1: Napisz failujące testy**

`src/setup-steps.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { detectChatId, ensureColumns, renderEnvFile } from './setup-steps.js';

describe('ensureColumns', () => {
  it('creates only the missing columns and returns every id', async () => {
    const trello = {
      lists: vi.fn().mockResolvedValue([
        { id: 'l-ready', name: 'Ready' },
        { id: 'l-done', name: 'Done' },
      ]),
      createList: vi.fn(async (_boardId: string, name: string) => ({ id: `new-${name}`, name })),
    };

    const ids = await ensureColumns(trello as never, 'board-1');

    expect(ids.ready).toBe('l-ready');
    expect(ids.done).toBe('l-done');
    expect(ids.inProgress).toBe('new-In Progress');
    expect(trello.createList).toHaveBeenCalledTimes(4);
  });

  it('creates nothing on a second run', async () => {
    const existing = [
      { id: '1', name: 'Backlog' },
      { id: '2', name: 'Ready' },
      { id: '3', name: 'In Progress' },
      { id: '4', name: 'Blocked' },
      { id: '5', name: 'Review' },
      { id: '6', name: 'Done' },
    ];
    const trello = { lists: vi.fn().mockResolvedValue(existing), createList: vi.fn() };

    await ensureColumns(trello as never, 'board-1');

    expect(trello.createList).not.toHaveBeenCalled();
  });
});

describe('detectChatId', () => {
  it('returns the chat id of the first message that arrives', async () => {
    const telegram = {
      getUpdates: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ updateId: 5, chatId: '42', text: 'hi', replyToText: null }]),
    };
    await expect(detectChatId(telegram as never, 0, { attempts: 5, delayMs: 0 })).resolves.toBe('42');
  });

  it('gives up after the configured attempts', async () => {
    const telegram = { getUpdates: vi.fn().mockResolvedValue([]) };
    await expect(detectChatId(telegram as never, 0, { attempts: 2, delayMs: 0 })).rejects.toThrow(
      /no message/i,
    );
  });
});

describe('renderEnvFile', () => {
  it('quotes every value so tokens with special characters survive', () => {
    const env = renderEnvFile({ TRELLO_TOKEN: 'ab#cd', GITHUB_OWNER: 'kostnerek' });
    expect(env).toContain('TRELLO_TOKEN="ab#cd"');
    expect(env.trim().split('\n')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/setup-steps.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj kroki**

`src/setup-steps.ts`:

```typescript
import type { ColumnName } from './config.js';
import type { TelegramClient } from './telegram.js';
import type { TrelloClient } from './trello.js';

export const COLUMN_TITLES: Record<ColumnName, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  inProgress: 'In Progress',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
};

export async function ensureColumns(
  trello: TrelloClient,
  boardId: string,
): Promise<Record<ColumnName, string>> {
  const existing = await trello.lists(boardId);
  const byName = new Map(existing.map((list) => [list.name.toLowerCase(), list.id]));
  const ids = {} as Record<ColumnName, string>;

  for (const [column, title] of Object.entries(COLUMN_TITLES) as [ColumnName, string][]) {
    const found = byName.get(title.toLowerCase());
    ids[column] = found ?? (await trello.createList(boardId, title)).id;
  }

  return ids;
}

export async function detectChatId(
  telegram: TelegramClient,
  sinceOffset: number,
  options: { attempts: number; delayMs: number },
): Promise<string> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const updates = await telegram.getUpdates(sinceOffset);
    const first = updates[0];
    if (first) {
      return first.chatId;
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  throw new Error('Received no message from you — send any text to the bot and run setup again.');
}

export function renderEnvFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}="${value}"`)
    .join('\n')}\n`;
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/setup-steps.test.ts`
Expected: PASS (5 testów)

- [ ] **Step 5: Napisz dialog kreatora**

`src/setup.ts`:

```typescript
import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { confirm, input, select } from '@inquirer/prompts';
import { GitHubClient } from './github.js';
import { COLUMN_TITLES, detectChatId, ensureColumns, renderEnvFile } from './setup-steps.js';
import { TelegramClient } from './telegram.js';
import { TrelloClient } from './trello.js';

const execFileAsync = promisify(execFile);

async function requireBinaries(): Promise<void> {
  const missing: string[] = [];
  for (const binary of ['herdr', 'docker', 'git']) {
    try {
      await execFileAsync('which', [binary]);
    } catch {
      missing.push(binary);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required binaries: ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  await requireBinaries();
  console.log('\n=== Trello ===');
  console.log('Open https://trello.com/power-ups/admin and copy your API key.');
  const trelloKey = await input({ message: 'Trello API key:' });
  console.log(
    `\nNow open this URL and approve access:\n` +
      `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=${trelloKey}\n`,
  );
  const trelloToken = await input({ message: 'Trello token:' });

  const trello = new TrelloClient({ key: trelloKey, token: trelloToken });
  const me = await trello.me();
  console.log(`Authenticated as ${me.username}.`);

  const boards = await trello.boards();
  const boardId = await select({
    message: 'Which board should Fiesta watch?',
    choices: [
      ...boards.map((board) => ({ name: board.name, value: board.id })),
      { name: '+ create a new board', value: '__new__' },
    ],
  });
  const board =
    boardId === '__new__' ? (await trello.createBoard(await input({ message: 'New board name:' }))).id : boardId;

  const lists = await ensureColumns(trello, board);
  console.log(`Columns ready: ${Object.values(COLUMN_TITLES).join(', ')}.`);

  console.log('\n=== Telegram ===');
  const telegramToken = await input({ message: 'Telegram bot token (from @BotFather):' });
  const telegram = new TelegramClient(telegramToken);
  const bot = await telegram.getMe();
  console.log(`Bot @${bot.username} reachable.`);
  await confirm({ message: `Send any message to @${bot.username}, then confirm here.` });
  const chatId = await detectChatId(telegram, 0, { attempts: 30, delayMs: 1000 });
  console.log(`Detected chat id ${chatId}.`);

  console.log('\n=== GitHub ===');
  const githubToken = await input({ message: 'GitHub token (scope: repo):' });
  const owner = (await new GitHubClient({ token: githubToken, owner: '' }).user()).login;
  console.log(`Authenticated as ${owner}.`);

  console.log('\n=== Paths ===');
  const root = await input({ message: 'Data root:', default: '/mnt/user/appdata/fiesta' });
  const claudeCredentials = await input({
    message: 'Claude credentials directory:',
    default: join(homedir(), '.claude'),
  });

  const envPath = join(process.cwd(), '.env');
  await writeFile(
    envPath,
    renderEnvFile({
      TRELLO_API_KEY: trelloKey,
      TRELLO_TOKEN: trelloToken,
      TRELLO_BOARD_ID: board,
      TRELLO_LIST_BACKLOG: lists.backlog,
      TRELLO_LIST_READY: lists.ready,
      TRELLO_LIST_IN_PROGRESS: lists.inProgress,
      TRELLO_LIST_BLOCKED: lists.blocked,
      TRELLO_LIST_REVIEW: lists.review,
      TRELLO_LIST_DONE: lists.done,
      TELEGRAM_BOT_TOKEN: telegramToken,
      TELEGRAM_CHAT_ID: chatId,
      GITHUB_TOKEN: githubToken,
      GITHUB_OWNER: owner,
      FIESTA_ROOT: root,
      CLAUDE_CREDENTIALS_PATH: claudeCredentials,
    }),
  );
  await chmod(envPath, 0o600);

  console.log(`\nWrote ${envPath}.`);
  console.log('Add one label per repository on the board, then start with: pnpm start');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 6: Uruchom kreator na żywo**

Run: `pnpm setup`
Expected: przechodzi wszystkie kroki, tworzy brakujące kolumny na boardzie, wykrywa `chat_id` po wysłaniu wiadomości do bota, zapisuje `.env` z prawami `600`. Uruchom drugi raz — kolumny nie mogą się zdublować.

- [ ] **Step 7: Commit**

```bash
git add src/setup.ts src/setup-steps.ts src/setup-steps.test.ts
git commit -m "Add interactive setup wizard that verifies every secret and seeds the board"
```

---

### Task 10: Prompt startowy i dispatcher

**Files:**
- Create: `src/prompt.ts`
- Create: `src/dispatcher.ts`
- Test: `src/dispatcher.test.ts`

**Interfaces:**
- Consumes: `Ticket`, `TrelloClient`, `HerdrClient`, `ensureMirror`, `prepareWorkspace`, `Config`
- Produces: `buildPrompt(ticket)`, `buildAgentCommand({ workspacePath, claudeCredentials, githubToken, prompt })`, `class Dispatcher` z `claimAndStart(card: TrelloCard): Promise<void>`

- [ ] **Step 1: Napisz failujące testy**

`src/dispatcher.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from './dispatcher.js';
import type { TrelloCard } from './ticket.js';

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'card-1',
    shortLink: 'aBcD1234',
    name: 'Add HELLO file',
    desc: 'Create HELLO.md',
    labels: [{ id: 'l', name: 'demo' }],
    idList: 'list-ready',
    ...overrides,
  };
}

function build() {
  const trello = { moveCard: vi.fn(), addComment: vi.fn() };
  const herdr = {
    createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' }),
    startAgent: vi.fn().mockResolvedValue('pane-1'),
  };
  const git = {
    ensureMirror: vi.fn().mockResolvedValue('/root/repos/demo'),
    prepareWorkspace: vi.fn().mockResolvedValue('/root/work/aBcD1234'),
  };
  const dispatcher = new Dispatcher({
    trello: trello as never,
    herdr: herdr as never,
    git: git as never,
    config: {
      trello: { lists: { inProgress: 'list-progress', blocked: 'list-blocked' } },
      github: { owner: 'kostnerek', token: 'gh' },
      paths: { root: '/root', claudeCredentials: '/creds' },
    } as never,
  });
  return { dispatcher, trello, herdr, git };
}

describe('Dispatcher.claimAndStart', () => {
  it('claims the card before doing any expensive work', async () => {
    const { dispatcher, trello, git } = build();
    await dispatcher.claimAndStart(makeCard());

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-progress');
    expect(trello.moveCard.mock.invocationCallOrder[0]!).toBeLessThan(
      git.ensureMirror.mock.invocationCallOrder[0]!,
    );
  });

  it('labels the herdr workspace with the card shortLink', async () => {
    const { dispatcher, herdr } = build();
    await dispatcher.claimAndStart(makeCard());
    expect(herdr.createWorkspace).toHaveBeenCalledWith('aBcD1234', '/root/work/aBcD1234');
  });

  it('sends an unreadable card to Blocked instead of guessing the repo', async () => {
    const { dispatcher, trello, git } = build();
    await dispatcher.claimAndStart(makeCard({ labels: [] }));

    expect(trello.moveCard).toHaveBeenLastCalledWith('card-1', 'list-blocked');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/exactly one label/));
    expect(git.ensureMirror).not.toHaveBeenCalled();
  });
});
```

Pierwszy test pilnuje kolejności ze specu — zajęcie karty **przed** kosztowną pracą jest tym, co uniemożliwia podwójny start.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/dispatcher.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj prompt**

`src/prompt.ts`:

```typescript
import type { Ticket } from './ticket.js';

export function buildPrompt(ticket: Ticket): string {
  return [
    'Use the orchestrate-ticket skill to deliver this ticket end to end.',
    '',
    `Repository: ${ticket.repo}`,
    `Base branch: ${ticket.baseBranch}`,
    `Working branch: ${ticket.branch} (already checked out in /workspace)`,
    '',
    `Title: ${ticket.title}`,
    '',
    'Description and acceptance criteria:',
    ticket.description,
  ].join('\n');
}

export function buildAgentCommand(params: {
  workspacePath: string;
  claudeCredentials: string;
  githubToken: string;
  prompt: string;
}): string {
  const encodedPrompt = Buffer.from(params.prompt, 'utf8').toString('base64');
  return [
    'docker run --rm -i',
    `-v ${params.workspacePath}:/workspace`,
    `-v ${params.claudeCredentials}:/home/agent/.claude:ro`,
    `-e GITHUB_TOKEN=${params.githubToken}`,
    `-e FIESTA_PROMPT_B64=${encodedPrompt}`,
    'fiesta-agent:latest',
  ].join(' ');
}
```

Prompt jedzie base64 przez zmienną środowiskową, bo trafia do `herdr pane run` jako fragment linii poleceń — treść ticketu zawiera cudzysłowy, nowe linie i backticki, które w innym wypadku rozerwałyby komendę.

- [ ] **Step 4: Zaimplementuj dispatcher**

`src/dispatcher.ts`:

```typescript
import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { buildAgentCommand, buildPrompt } from './prompt.js';
import { TicketError, toTicket, type TrelloCard } from './ticket.js';
import type { TrelloClient } from './trello.js';
import type { ensureMirror, prepareWorkspace } from './workspace.js';

type GitOperations = {
  ensureMirror: typeof ensureMirror;
  prepareWorkspace: typeof prepareWorkspace;
};

export class Dispatcher {
  constructor(
    private readonly deps: {
      trello: TrelloClient;
      herdr: HerdrClient;
      git: GitOperations;
      config: Config;
    },
  ) {}

  async claimAndStart(card: TrelloCard): Promise<void> {
    const { trello, herdr, git, config } = this.deps;

    let ticket;
    try {
      ticket = toTicket(card);
    } catch (error) {
      if (!(error instanceof TicketError)) {
        throw error;
      }
      await trello.moveCard(card.id, config.trello.lists.blocked);
      await trello.addComment(card.id, `🤖 ${error.message}`);
      return;
    }

    await trello.moveCard(card.id, config.trello.lists.inProgress);

    const mirrorPath = await git.ensureMirror({
      root: config.paths.root,
      owner: config.github.owner,
      repo: ticket.repo,
      token: config.github.token,
    });
    const workspacePath = await git.prepareWorkspace({ root: config.paths.root, mirrorPath, ticket });

    const workspace = await herdr.createWorkspace(ticket.shortLink, workspacePath);
    await herdr.startAgent({
      workspaceId: workspace.id,
      name: ticket.shortLink,
      command: buildAgentCommand({
        workspacePath,
        claudeCredentials: config.paths.claudeCredentials,
        githubToken: config.github.token,
        prompt: buildPrompt(ticket),
      }),
    });

    await trello.addComment(card.id, `🤖 Started on branch \`${ticket.branch}\` (workspace ${workspace.id}).`);
  }
}
```

- [ ] **Step 5: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/dispatcher.test.ts`
Expected: PASS (3 testy)

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts src/dispatcher.ts src/dispatcher.test.ts
git commit -m "Add dispatcher that claims a card before provisioning its agent"
```

---

### Task 11: Escalator

**Files:**
- Create: `src/escalator.ts`
- Test: `src/escalator.test.ts`

**Interfaces:**
- Consumes: `HerdrClient`, `TelegramClient`, `TrelloClient`, `findLastMarker`, `Config`
- Produces: `class Escalator` z `inspect(ticket: Ticket, paneId: string, lastSeenAt: number)` oraz `deliverReplies()`

- [ ] **Step 1: Napisz failujące testy**

`src/escalator.test.ts`:

```typescript
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
```

Test „keeps waiting" i test timeoutu razem kodują regułę ze specu: zegar mierzy **ciszę**, a agent w `working` nie jest cichy.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/escalator.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/escalator.ts`:

```typescript
import type { Config } from './config.js';
import type { HerdrClient } from './herdr.js';
import { findLastMarker } from './markers.js';
import type { Ticket } from './ticket.js';
import { extractShortLink, formatEscalation, type TelegramClient } from './telegram.js';
import type { TrelloClient } from './trello.js';

export type Outcome = 'running' | 'blocked' | 'review';

export type ActiveTicket = { ticket: Ticket; paneId: string };

export class Escalator {
  private telegramOffset = 0;

  constructor(
    private readonly deps: {
      herdr: HerdrClient;
      telegram: TelegramClient;
      trello: TrelloClient;
      config: Config;
    },
  ) {}

  async inspect(ticket: Ticket, paneId: string, lastActivityAt: number): Promise<Outcome> {
    const { herdr, telegram, trello, config } = this.deps;
    const marker = findLastMarker(await herdr.readPane(paneId));

    if (marker) {
      const list = marker.kind === 'DONE' ? config.trello.lists.review : config.trello.lists.blocked;
      await trello.moveCard(ticket.cardId, list);
      await trello.addComment(ticket.cardId, `🤖 ${marker.kind}: ${marker.text}`);
      await telegram.send(
        config.telegram.chatId,
        formatEscalation({ shortLink: ticket.shortLink, title: ticket.title, marker }),
      );
      return marker.kind === 'DONE' ? 'review' : 'blocked';
    }

    const status = await herdr.paneStatus(paneId);
    const silentFor = Date.now() - lastActivityAt;
    if (status !== 'working' && silentFor > config.limits.ticketTimeoutMs) {
      await trello.moveCard(ticket.cardId, config.trello.lists.blocked);
      await trello.addComment(
        ticket.cardId,
        `🤖 Agent timed out after ${Math.round(silentFor / 60000)} minutes without a marker.`,
      );
      await telegram.send(
        config.telegram.chatId,
        formatEscalation({
          shortLink: ticket.shortLink,
          title: ticket.title,
          marker: { kind: 'FAIL', text: 'timed out with no marker' },
        }),
      );
      return 'blocked';
    }

    return 'running';
  }

  async deliverReplies(active: Map<string, ActiveTicket>): Promise<void> {
    const { herdr, telegram, trello, config } = this.deps;
    const updates = await telegram.getUpdates(this.telegramOffset);

    for (const update of updates) {
      this.telegramOffset = update.updateId + 1;
      if (!update.replyToText) {
        continue;
      }
      const shortLink = extractShortLink(update.replyToText);
      const target = shortLink ? active.get(shortLink) : undefined;
      if (!target) {
        continue;
      }
      await herdr.sendText(target.paneId, update.text);
      await trello.moveCard(target.ticket.cardId, config.trello.lists.inProgress);
      await trello.addComment(target.ticket.cardId, `🤖 Answer delivered: ${update.text}`);
    }
  }
}
```

- [ ] **Step 4: Uruchom testy — mają przejść**

Run: `pnpm vitest run src/escalator.test.ts`
Expected: PASS (6 testów)

- [ ] **Step 5: Commit**

```bash
git add src/escalator.ts src/escalator.test.ts
git commit -m "Add escalator bridging pane markers to Telegram and replies back"
```

---

### Task 12: Pętla główna i odzyskiwanie po restarcie

**Files:**
- Create: `src/loop.ts`
- Create: `src/main.ts`
- Test: `src/loop.test.ts`

**Interfaces:**
- Consumes: wszystko powyżej
- Produces: `class Loop` z `recover()`, `tick()`; `main.ts` jako punkt wejścia

- [ ] **Step 1: Napisz failujące testy**

`src/loop.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { Loop } from './loop.js';
import type { TrelloCard } from './ticket.js';

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'card-1',
    shortLink: 'aBcD1234',
    name: 'Add HELLO file',
    desc: '',
    labels: [{ id: 'l', name: 'demo' }],
    idList: 'list-ready',
    ...overrides,
  };
}

function build(overrides: { ready?: TrelloCard[]; inProgress?: TrelloCard[]; review?: TrelloCard[] } = {}) {
  const trello = {
    cardsInList: vi.fn(async (listId: string) => {
      if (listId === 'list-ready') return overrides.ready ?? [];
      if (listId === 'list-progress') return overrides.inProgress ?? [];
      if (listId === 'list-review') return overrides.review ?? [];
      return [];
    }),
    moveCard: vi.fn(),
    addComment: vi.fn(),
  };
  const herdr = { findWorkspaceByLabel: vi.fn().mockResolvedValue(null), killWorkspace: vi.fn() };
  const dispatcher = { claimAndStart: vi.fn() };
  const github = { findPrByBranch: vi.fn().mockResolvedValue(null) };
  const loop = new Loop({
    trello: trello as never,
    herdr: herdr as never,
    github: github as never,
    dispatcher: dispatcher as never,
    escalator: { inspect: vi.fn(), deliverReplies: vi.fn() } as never,
    removeWorkspace: vi.fn(),
    config: {
      trello: {
        lists: {
          ready: 'list-ready',
          inProgress: 'list-progress',
          blocked: 'list-blocked',
          review: 'list-review',
          done: 'list-done',
        },
      },
      limits: { maxActive: 1 },
      paths: { root: '/root' },
    } as never,
  });
  return { loop, trello, herdr, dispatcher, github };
}

describe('Loop.recover', () => {
  it('returns an orphaned In Progress card to Ready', async () => {
    const { loop, trello } = build({ inProgress: [makeCard()] });
    await loop.recover();
    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-ready');
    expect(trello.addComment).toHaveBeenCalledWith('card-1', expect.stringMatching(/restart/i));
  });

  it('leaves an In Progress card whose workspace is alive', async () => {
    const { loop, trello, herdr } = build({ inProgress: [makeCard()] });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });
    await loop.recover();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});

describe('Loop.tick', () => {
  it('starts a ready card when below the active limit', async () => {
    const { loop, dispatcher } = build({ ready: [makeCard()] });
    await loop.tick();
    expect(dispatcher.claimAndStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-1' }));
  });

  it('starts nothing when the active limit is reached', async () => {
    const { loop, dispatcher } = build({ ready: [makeCard({ id: 'card-2' })], inProgress: [makeCard()] });
    await loop.tick();
    expect(dispatcher.claimAndStart).not.toHaveBeenCalled();
  });

  it('closes a reviewed card once its pull request is merged', async () => {
    const { loop, trello, github, herdr } = build({ review: [makeCard()] });
    github.findPrByBranch.mockResolvedValue({ number: 7, url: 'https://pr/7', merged: true });
    herdr.findWorkspaceByLabel.mockResolvedValue({ id: 'ws-1', label: 'aBcD1234' });

    await loop.tick();

    expect(trello.moveCard).toHaveBeenCalledWith('card-1', 'list-done');
    expect(herdr.killWorkspace).toHaveBeenCalledWith('ws-1');
  });
});
```

- [ ] **Step 2: Uruchom test — ma failować**

Run: `pnpm vitest run src/loop.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj pętlę**

`src/loop.ts`:

```typescript
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import type { ActiveTicket, Escalator } from './escalator.js';
import type { GitHubClient } from './github.js';
import type { HerdrClient } from './herdr.js';
import { TicketError, toTicket, type Ticket, type TrelloCard } from './ticket.js';
import type { TrelloClient } from './trello.js';
import type { removeWorkspace } from './workspace.js';

function readTicket(card: TrelloCard): Ticket | null {
  try {
    return toTicket(card);
  } catch (error) {
    if (error instanceof TicketError) {
      return null;
    }
    throw error;
  }
}

export class Loop {
  private readonly lastActivityAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      trello: TrelloClient;
      herdr: HerdrClient;
      github: GitHubClient;
      dispatcher: Dispatcher;
      escalator: Escalator;
      removeWorkspace: typeof removeWorkspace;
      config: Config;
    },
  ) {}

  async recover(): Promise<void> {
    const { trello, herdr, config } = this.deps;
    for (const card of await trello.cardsInList(config.trello.lists.inProgress)) {
      if (await herdr.findWorkspaceByLabel(card.shortLink)) {
        continue;
      }
      await trello.moveCard(card.id, config.trello.lists.ready);
      await trello.addComment(card.id, '🤖 Interrupted by a restart — returning to Ready for a fresh run.');
    }
  }

  async tick(): Promise<void> {
    const { trello, herdr, dispatcher, escalator, config } = this.deps;

    const inProgress = await trello.cardsInList(config.trello.lists.inProgress);
    const blocked = await trello.cardsInList(config.trello.lists.blocked);
    const active = new Map<string, ActiveTicket>();

    for (const card of [...inProgress, ...blocked]) {
      const workspace = await herdr.findWorkspaceByLabel(card.shortLink);
      const ticket = workspace ? readTicket(card) : null;
      if (!workspace || !ticket) {
        continue;
      }
      active.set(card.shortLink, { ticket, paneId: `${workspace.id}:1` });
    }

    await escalator.deliverReplies(active);

    for (const card of inProgress) {
      const entry = active.get(card.shortLink);
      if (!entry) {
        continue;
      }
      const since = this.lastActivityAt.get(card.shortLink) ?? Date.now();
      this.lastActivityAt.set(card.shortLink, since);
      const outcome = await escalator.inspect(entry.ticket, entry.paneId, since);
      if (outcome !== 'running') {
        this.lastActivityAt.delete(card.shortLink);
      }
    }

    await this.closeMerged();

    if (inProgress.length + blocked.length < config.limits.maxActive) {
      const ready = await trello.cardsInList(config.trello.lists.ready);
      const next = ready[0];
      if (next) {
        await dispatcher.claimAndStart(next);
      }
    }
  }

  private async closeMerged(): Promise<void> {
    const { trello, herdr, github, config } = this.deps;
    for (const card of await trello.cardsInList(config.trello.lists.review)) {
      const ticket = readTicket(card);
      if (!ticket) {
        continue;
      }
      const pr = await github.findPrByBranch(ticket.repo, ticket.branch);
      if (!pr?.merged) {
        continue;
      }
      await trello.moveCard(card.id, config.trello.lists.done);
      await trello.addComment(card.id, `🤖 Merged: ${pr.url}`);
      const workspace = await herdr.findWorkspaceByLabel(card.shortLink);
      if (workspace) {
        await herdr.killWorkspace(workspace.id);
      }
      await this.deps.removeWorkspace({ root: config.paths.root, shortLink: card.shortLink });
    }
  }
}
```

Uwaga do `paneId`: składamy go z id workspace'a. Jeśli fixtures z Taska 5 pokazują inny sposób adresowania panelu, zamień to na `herdr pane list --workspace <id>` i wzięcie pierwszego panelu — poprawka jest lokalna.

- [ ] **Step 4: Napisz punkt wejścia**

`src/main.ts`:

```typescript
import { Dispatcher } from './dispatcher.js';
import { loadConfig } from './config.js';
import { Escalator } from './escalator.js';
import { GitHubClient } from './github.js';
import { HerdrClient } from './herdr.js';
import { Loop } from './loop.js';
import { TelegramClient } from './telegram.js';
import { TrelloClient } from './trello.js';
import { ensureMirror, prepareWorkspace, removeWorkspace } from './workspace.js';

const config = loadConfig(process.env);

const trello = new TrelloClient({ key: config.trello.key, token: config.trello.token });
const herdr = new HerdrClient();
const telegram = new TelegramClient(config.telegram.botToken);
const github = new GitHubClient({ token: config.github.token, owner: config.github.owner });

const loop = new Loop({
  trello,
  herdr,
  github,
  dispatcher: new Dispatcher({ trello, herdr, git: { ensureMirror, prepareWorkspace }, config }),
  escalator: new Escalator({ herdr, telegram, trello, config }),
  removeWorkspace,
  config,
});

await loop.recover();

for (;;) {
  try {
    await loop.tick();
  } catch (error) {
    console.error('[fiesta] tick failed', error);
  }
  await new Promise((resolve) => setTimeout(resolve, config.limits.pollIntervalMs));
}
```

Pętla łapie każdy błąd `tick()` i idzie dalej. Daemon, który przewraca się na jednym `502` z Trello, przestaje pilnować boardu do rana.

- [ ] **Step 5: Uruchom testy — mają przejść**

Run: `pnpm vitest run`
Expected: PASS — wszystkie pliki testowe

- [ ] **Step 6: Commit**

```bash
git add src/loop.ts src/loop.test.ts src/main.ts
git commit -m "Add poll loop with restart recovery and merge-driven cleanup"
```

---

### Task 13: Obraz agenta i uruchomienie daemona

**Files:**
- Create: `docker/agent.Dockerfile`
- Create: `docker/entrypoint.sh`
- Create: `docker-compose.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `buildAgentCommand` z `src/prompt.ts` (obraz `fiesta-agent:latest`, `/workspace`, `/home/agent/.claude`, `FIESTA_PROMPT_B64`)

- [ ] **Step 1: Napisz obraz agenta**

`docker/agent.Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd --create-home --uid 1001 agent
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

`docker/entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

git config --global user.name "fiesta-agent"
git config --global user.email "fiesta-agent@localhost"
git config --global --add safe.directory /workspace

echo "$FIESTA_PROMPT_B64" | base64 -d > /tmp/prompt.txt

exec claude --dangerously-skip-permissions "$(cat /tmp/prompt.txt)"
```

- [ ] **Step 2: Zbuduj obraz i sprawdź, że agent w nim startuje**

```bash
docker build -t fiesta-agent:latest docker/
docker run --rm -v "$HOME/.claude:/home/agent/.claude:ro" \
  -e FIESTA_PROMPT_B64="$(printf 'Reply with exactly: @@FIESTA:DONE smoke-test' | base64)" \
  fiesta-agent:latest
```

Expected: agent odpowiada linią `@@FIESTA:DONE smoke-test`. Jeśli zamiast tego zgłasza brak uwierzytelnienia, poświadczenia Claude nie zamontowały się poprawnie — napraw to teraz, zanim pójdziesz dalej.

- [ ] **Step 3: Napisz compose dla daemona**

`docker-compose.yml`:

```yaml
services:
  fiesta:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - /mnt/user/appdata/fiesta:/mnt/user/appdata/fiesta
      - /var/run/docker.sock:/var/run/docker.sock
      - ${CLAUDE_CREDENTIALS_PATH}:${CLAUDE_CREDENTIALS_PATH}:ro
    network_mode: host
```

Daemon montuje docker socket, bo to on uruchamia kontenery agentów. To celowe rozluźnienie **dla daemona** — granicą bezpieczeństwa jest kontener agenta, który socketu nie widzi.

- [ ] **Step 4: Napisz README z instrukcją uruchomienia**

`README.md` — sekcje: wymagania (herdr, docker, git, Node 22), `pnpm install`, `pnpm setup`, `docker build -t fiesta-agent:latest docker/`, `docker compose up -d`, jak dodać repo (label na boardzie), jak podłączyć się do sesji (`herdr --remote <host>`), gdzie leżą dane (`/mnt/user/appdata/fiesta`).

- [ ] **Step 5: Commit**

```bash
git add docker docker-compose.yml README.md
git commit -m "Add agent container image, daemon compose and setup README"
```

---

### Task 14: Skille agenta

**Files:**
- Create: `skills/orchestrate-ticket/SKILL.md`
- Create: `skills/verify-ticket/SKILL.md`
- Modify: `docker/agent.Dockerfile` (kopiowanie skilli do obrazu)

- [ ] **Step 1: Napisz `orchestrate-ticket`**

`skills/orchestrate-ticket/SKILL.md` zaczyna się dokładnie tym frontmatterem:

```markdown
---
name: orchestrate-ticket
description: Use when handed a Fiesta ticket to deliver end to end — plan, implement, verify, push and open a draft PR, ending the turn with exactly one @@FIESTA marker.
---
```

Dalej treść pokrywająca:

1. **Przebieg:** zrozum ticket → rozpoznaj repo (CLAUDE.md, testy, konwencje) → zaplanuj → zaimplementuj → uruchom `verify-ticket` → push → draft PR → `@@FIESTA:DONE <url>`.
2. **Reguła autonomii — dwuetapowy test, dosłownie ze specu:**
   - Da się ustalić z kodu, testów, historii gita, konwencji, opisu karty? → **ustal i rób**.
   - Nie da się, ale zła decyzja jest odwracalna w review? → **zdecyduj, rób, zapisz w sekcji „Assumptions" opisu PR**.
   - Nie da się i jest nieodwracalna (pieniądze, dane produkcyjne, bezpieczeństwo, coś wysłanego w świat)? → `@@FIESTA:ASK`.
3. **Pytaj na starcie, nie na końcu.**
4. **Subagenci domyślnie wyłączeni** — tylko zadania rozłączne plikowo albo read-only, bo wszyscy dzielą `/workspace`.
5. **Sekcja „Assumptions" w opisie PR jest obowiązkowa** (wpisz „none", jeśli żadnych nie było).
6. **Zakończ turę dokładnie jednym markerem** na początku linii: `@@FIESTA:ASK`, `@@FIESTA:DONE`, `@@FIESTA:FAIL`.

- [ ] **Step 2: Napisz `verify-ticket`**

`skills/verify-ticket/SKILL.md` zaczyna się dokładnie tym frontmatterem:

```markdown
---
name: verify-ticket
description: Use before opening a pull request — run the repo's own tests, lint and typecheck, then walk the ticket's acceptance criteria one by one with evidence for each.
---
```

Dalej treść pokrywająca:

1. Wykryj komendy testów, lintu i typechecku z repo (`package.json`, `Makefile`, CI).
2. Uruchom je i **wklej output**.
3. Przejdź po kryteriach akceptacji z opisu ticketu **jeden po drugim**, każdemu przypisz PASS/FAIL z dowodem.
4. Twarde zasady: żadnego „przeszło" bez outputu komendy; żaden PR nie powstaje przy czerwonych testach — wtedy `@@FIESTA:FAIL <powód>`.

- [ ] **Step 3: Wbuduj skille w obraz**

W `docker/agent.Dockerfile`, przed `USER agent`:

```dockerfile
COPY skills /home/agent/.claude/skills
RUN chown -R agent:agent /home/agent/.claude
```

Ponieważ katalog poświadczeń jest montowany read-only w `/home/agent/.claude`, przenieś skille poza mount:

```dockerfile
COPY skills /opt/fiesta-skills
ENV CLAUDE_SKILLS_DIR=/opt/fiesta-skills
```

Zweryfikuj w kroku 4, którą ścieżkę Claude Code faktycznie czyta; jeśli nie honoruje `CLAUDE_SKILLS_DIR`, zamontuj poświadczenia pod `/home/agent/.claude/.credentials.json` zamiast całego katalogu i zostaw skille w `/home/agent/.claude/skills` — wtedy zaktualizuj `buildAgentCommand` w `src/prompt.ts`.

- [ ] **Step 4: Sprawdź, że agent widzi skill**

```bash
docker build -t fiesta-agent:latest -f docker/agent.Dockerfile .
docker run --rm -v "$HOME/.claude:/home/agent/.claude:ro" \
  -e FIESTA_PROMPT_B64="$(printf 'List the skills you can see, then end with @@FIESTA:DONE probe' | base64)" \
  fiesta-agent:latest
```

Expected: w odpowiedzi widnieją `orchestrate-ticket` i `verify-ticket`.

- [ ] **Step 5: Commit**

```bash
git add skills docker/agent.Dockerfile src/prompt.ts
git commit -m "Add orchestrate-ticket and verify-ticket skills to the agent image"
```

---

### Task 15: Test end-to-end na żywo

Jedyny test, który dowodzi, że pętla działa. Reszta dowodzi, że jej nie zepsuliśmy.

**Files:**
- Modify: `README.md` (sekcja „Smoke test")

- [ ] **Step 1: Przygotuj repo docelowe**

Utwórz na GitHubie puste repo `fiesta-smoke` z plikiem `README.md` i gałęzią `main`. Dodaj na boardzie label o nazwie dokładnie `fiesta-smoke`.

- [ ] **Step 2: Uruchom daemona**

```bash
docker compose up -d
docker compose logs -f fiesta
```

Expected: log pokazuje `recover()` bez błędów i cykliczne `tick()` co 30 s.

- [ ] **Step 3: Wrzuć kartę**

Na boardzie, w kolumnie `Ready`, karta:
- Tytuł: `Add HELLO file`
- Label: `fiesta-smoke`
- Opis:
  ```
  Create HELLO.md at the repository root containing the single line: hello from fiesta

  Acceptance criteria:
  - HELLO.md exists at the repo root
  - Its content is exactly "hello from fiesta"
  ```

- [ ] **Step 4: Zweryfikuj cały przebieg**

Sprawdź po kolei:
1. W ciągu 30 s karta przechodzi do `In Progress` z komentarzem o gałęzi.
2. `herdr --remote <host>` pokazuje workspace o labelu równym `shortLink` karty, a w nim pracującego agenta.
3. Karta ląduje w `Review`, komentarz zawiera link do draft PR-a.
4. Na Telegram przychodzi wiadomość z linkiem.
5. PR jest draftem, zawiera `HELLO.md` i sekcję `Assumptions`.
6. Po zmergowaniu PR-a karta w ciągu 30 s przechodzi do `Done`, a workspace i katalog `work/<shortLink>` znikają.

- [ ] **Step 5: Zweryfikuj ścieżkę eskalacji**

Nowa karta w `Ready`, label `fiesta-smoke`, tytuł `Add a config file`, opis celowo niepełny w sposób nieodwracalny:

```
Add a config file with the production database password.

Acceptance criteria:
- The file contains the real production credentials
```

Expected: agent nie zgaduje. Karta trafia do `Blocked`, na Telegram przychodzi pytanie z `[shortLink]`. Odpowiedz **przez reply**: `Skip it — use a placeholder value and note the assumption`. W ciągu 30 s karta wraca do `In Progress`, a agent kontynuuje.

- [ ] **Step 6: Uzupełnij README i zacommituj**

```bash
git add README.md
git commit -m "Document the end-to-end smoke test"
```

---

## Kolejność i zależności

Taski 1–8 są niezależne od siebie po Tasku 1 i mogą iść w dowolnej kolejności. Task 9 potrzebuje 4, 7, 8. Task 10 potrzebuje 3, 4, 5, 6. Task 11 potrzebuje 2, 4, 5, 8. Task 12 potrzebuje 10 i 11. Taski 13–15 zamykają całość i muszą iść po 12.
