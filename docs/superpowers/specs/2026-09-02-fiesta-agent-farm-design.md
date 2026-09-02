# Fiesta — farma autonomicznych agentów (design MVP)

Data: 2026-09-02
Status: zaakceptowany do implementacji

## 1. Cel

Serwer domowy (Unraid) uruchamia agentów kodujących, którzy pracują autonomicznie
na podstawie kart z boardu kanbanowego. Agent bierze ticket, implementuje zmianę,
testuje ją i otwiera draft PR. Gdy trafi na coś, czego nie jest w stanie ustalić
sam, pinguje człowieka na Telegramie i czeka na odpowiedź — którą można wysłać
z Telegrama albo wpisać wprost do sesji przez klienta herdr.

To jest projekt **B** z trzyczęściowego podziału. Projekt A (jeden docker compose
podnoszący cały stack tsoft na serwerze) i C (połączenie A z B) są poza zakresem
tego dokumentu.

### Kryteria sukcesu MVP

1. Karta wrzucona do kolumny `Ready` powoduje powstanie draft PR-a bez udziału
   człowieka.
2. Agent, który nie może czegoś ustalić, pinguje Telegram; odpowiedź wysłana
   przez reply wraca do sesji i praca leci dalej.
3. Restart serwera nie gubi ticketu ani nie duplikuje pracy.
4. Da się podłączyć do żywej sesji z laptopa i zobaczyć, co agent robi.

## 2. Ograniczenia

- **Unraid trzyma OS w RAM.** Wszystko poza `/boot` i `/mnt` znika po reboocie.
  Instalacja herdr ze skryptu shell nie przeżyje restartu — potrzebny kontener
  albo user-script. Stan aplikacji leży w `/mnt/user/appdata/fiesta/`.
- **Dostęp zdalny przez Tailscale.** Nic nie jest wystawione na publiczny
  internet.
- **Herdr nie ma web dashboardu.** Zdalny dostęp to `herdr --remote <host>` —
  cienki klient po SSH streamujący UI do lokalnego terminala. Z telefonu wymaga
  aplikacji SSH, więc ścieżką mobilną jest Telegram, a herdr desktopową.
- **Uwierzytelnianie Claude z subskrypcji**, poświadczenia współdzielone między
  agentem a pracą własną użytkownika. To wyklucza równoległych agentów: dzielą
  te same limity.

## 3. Architektura

Zasada podziału: **deterministyczne — w kodzie, niedeterministyczne — w agencie.**
Daemon musi działać miesiącami bez nadzoru, więc nie może być modelem językowym.
Agent musi rozumieć ticket, więc nie może być skryptem.

| Komponent | Odpowiedzialność |
|---|---|
| `trello-poller` | Odpytuje board co ~30 s. Nowa karta w `Ready` → zdarzenie `ticket.new`. Karta w `Review` → sprawdza stan jej PR-a; po merge → zdarzenie `ticket.merged`. |
| `dispatcher` | Zajmuje kartę, przygotowuje katalog roboczy i kontener, tworzy workspace w herdr, startuje agenta z promptem. |
| `escalator` | Nasłuchuje markerów w panelach; `ASK`/`FAIL`/`DONE` → Telegram. Reply z Telegrama → `pane send-text`. |
| `skill: orchestrate-ticket` | Playbook agenta: od ticketu do draft PR-a. |
| `skill: verify-ticket` | Generyczne QA przed otwarciem PR-a. |
| `setup` | Interaktywny kreator: zbiera i weryfikuje sekrety, zakłada kolumny na boardzie, zapisuje `.env`. |

Poller odpytuje **Trello**, ale stanów paneli **nie odpytuje** — do tego służy
subskrypcja zdarzeń w socket API herdr.

Webhooki Trello (zamiast pollingu) są świadomie odłożone: wymagałyby publicznego
URL, czyli kolejnej ruchomej części i powierzchni ataku. Wymiana pollera na
webhook nie ruszy reszty systemu.

### Setup

`fiesta setup` — interaktywny, idempotentny kreator uruchamiany raz na serwerze.
Prowadzi przez wszystko, czego system potrzebuje, i **weryfikuje każdy sekret
w momencie podania**. Kreator, który zapisuje zły token na ślepo, tylko przenosi
awarię na godzinę, w której nikt nie patrzy.

1. Wymagania: `herdr`, `docker`, `git` obecne w PATH.
2. **Trello** — klucz API, potem gotowy do kliknięcia URL autoryzacyjny, potem
   token. Weryfikacja przez `GET /1/members/me`.
3. **Board** — wybór istniejącego z listy albo utworzenie nowego.
4. **Kolumny** — brakujące z zestawu `Backlog`, `Ready`, `In Progress`,
   `Blocked`, `Review`, `Done` zostają utworzone. Dopasowanie po nazwie, więc
   istniejące kolumny są nietykane, a ponowny setup nic nie duplikuje.
5. **Telegram** — token bota, weryfikacja przez `getMe`, następnie prośba
   o wysłanie dowolnej wiadomości do bota i **automatyczne wykrycie `chat_id`**
   z `getUpdates`. Użytkownik nie musi znać swojego ID ani go szukać.
6. **GitHub** — token, weryfikacja przez `GET /user`, **owner odczytany
   automatycznie** z odpowiedzi.
7. **Ścieżki** — katalog roboczy (domyślnie `/mnt/user/appdata/fiesta`) oraz
   lokalizacja poświadczeń Claude.
8. Zapis `.env` z uprawnieniami `600` i podsumowanie.

Ponowne uruchomienie aktualizuje konfigurację bez efektów ubocznych, więc
`fiesta setup` jest jednocześnie narzędziem diagnostycznym po wymianie tokenu.

## 4. Kontrakt karty i maszyna stanów

### Kolumny

`Backlog` (ignorowana) → `Ready` (wyzwalacz) → `In Progress` → `Blocked` →
`Review` → `Done`

Board nie jest tylko widokiem — jest interfejsem sterującym.

### Stan żyje na boardzie, nie w daemonie

Daemon nie prowadzi żadnej bazy przetworzonych kart. Prawdą jest kolumna, w której
leży karta. Dzięki temu daemon jest bezstanowy i wymienny, przeżywa restart
Unraida bez wolumenu, a użytkownik widzi dokładnie ten stan, na którym daemon
operuje. Lokalna baza byłaby drugim źródłem prawdy, które prędzej czy później
rozjedzie się z boardem i zacznie gubić albo dublować tickety.

### Claim przed startem

Dispatcher **najpierw** przenosi kartę do `In Progress`, dopiero potem odpala
agenta. Przeniesienie jest zajęciem zadania, więc dwa cykle pollingu nie
wystartują tego samego ticketu — drugi zastanie pustą kolumnę.

### Dane na karcie

| Dane | Nośnik | Uzasadnienie |
|---|---|---|
| Zadanie | tytuł + opis | — |
| Kryteria akceptacji | opis karty | Czytane przez `verify-ticket` przypadek po przypadku. |
| **Repo** | **label** | Wybór z listy zamiast wpisywania — brak literówek, widoczne na froncie karty, jedno pole w API. Free-text pozwoliłby wysłać agenta do nieistniejącego repo. |
| Base branch | `base: <branch>` w opisie; domyślnie `main` | Potrzebne rzadko; osobne pole kosztowałoby więcej uwagi, niż jest warte. |
| Workspace, PR, założenia | komentarze bota | Ślad audytowy tam, gdzie użytkownik i tak patrzy. |

### Nazwa gałęzi

`fiesta/<shortLink-karty>-<slug-tytułu>`

`shortLink` jest stabilny, więc ponowne uruchomienie tej samej karty trafia w tę
samą gałąź zamiast mnożyć śmieci.

### Przebieg

1. Poller widzi kartę w `Ready`.
2. Dispatcher zajmuje ją (przeniesienie do `In Progress` + komentarz startowy).
3. Klon repo, kontener, workspace w herdr, `herdr agent start --kind claude`.
4. Prompt = `orchestrate-ticket` + treść karty + repo + base branch.
5. Agent pracuje. `ASK` → karta do `Blocked`, pytanie na Telegram. `FAIL` →
   karta do `Blocked`, informacja na Telegram.
6. Odpowiedź człowieka (reply na Telegramie albo wpisanie wprost w panel przez
   klienta herdr) → karta wraca do `In Progress`, agent kontynuuje. Ta sama karta
   może przejść przez `Blocked` wiele razy.
7. `DONE` → push, draft PR, komentarz z linkiem, karta → `Review`.
8. Poller wykrywa merge PR-a → karta `Done`, sprzątanie kontenera i workspace'a.

Karta w `Blocked` nadal zajmuje slot `MAX_ACTIVE` — jej kontener i sesja żyją,
czekając na odpowiedź.

### Poza zakresem

**Edycja karty w trakcie pracy agenta jest ignorowana.** Obsługa wymagałaby
kanału „zmieniły się wymagania" do biegnącej sesji. W MVP zmiana wymagań =
przeniesienie karty z powrotem do `Ready`.

## 5. Izolacja i cykl życia

### Układ na dysku

```
/mnt/user/appdata/fiesta/
  repos/<repo>/     lustro, tylko fetch, agent nigdy tego nie dotyka
  work/<shortLink>/ katalog roboczy jednego ticketu
```

### Repozytoria bez rejestracji

Setup nie pyta, **nad czym** agent będzie pracował — pyta tylko, **gdzie**. Label
na karcie nazywa repo, a dispatcher przy pierwszym użyciu klonuje lustro
z `<owner>/<label>`. Nie ma listy projektów do utrzymania ani kroku „zarejestruj
repozytorium": dodanie nowego projektu to dodanie labela na boardzie.

### Klon, nie worktree

`git worktree` byłby tańszy, ale trzyma `.git` jako wskaźnik do głównego repo —
kontener musiałby dostać zapis do metadanych **wszystkich** ticketów, co
przekreśla izolację kupioną kontenerem. Zamiast tego host robi `git clone --local`
z lustra: hardlinki na obiektach czynią to niemal darmowym, a wynik jest
samodzielnym repo. Kontener montuje jeden katalog i nie widzi nic poza nim.

Do zweryfikowania w fazie A: hardlinki nie przechodzą przez granicę mountów, więc
dla dużego repo (tsoft) klon może zejść do kopiowania. Wtedy wrócimy do worktree
z węższym mountem.

### Kontener jednorazowy

Jeden ticket = jeden kontener, ubijany po zamknięciu karty. Kontener
długożyjący oszczędziłby sekund startu, ale gromadziłby stan między ticketami
(zainstalowane paczki, śmieci w `/tmp`, zmienione configi) i pierwszy dziwny bug
byłby nie do odtworzenia.

Montowane: `work/<shortLink>` jako `/workspace` (rw), poświadczenia Claude (ro).
Wstrzykiwane: token GitHub jako zmienna środowiskowa.

Agent działa z pominięciem promptów o uprawnienia — pełna autonomia jest możliwa
tylko wtedy. Granicą bezpieczeństwa jest kontener, nie system uprawnień: agent
nie widzi kluczy SSH, pozostałych repo ani docker socketu.

### Workspace herdr

Label workspace'a = `shortLink` karty. Panel 1 to orkiestrator; subagentów, gdy
są potrzebne, dokłada on sam w tym samym workspace. Dzięki temu **można wejść
w każdego subagenta osobno** — przy subagentach Claude Code (Task) byłoby to
niemożliwe, bo są niewidoczne z zewnątrz. To był główny argument za panelami.

### Sprzątanie z wyjątkiem

Po merge kontener i workspace znikają. **Przy błędzie zostają** — karta idzie do
`Blocked`, panel czeka na oględziny. Autonomiczny system, który sprząta po swoich
awariach, nie daje się debugować.

### Równoległość

`MAX_ACTIVE = 1`. Jedna karta na raz — równolegli agenci konkurowaliby o limity
subskrypcji, także z pracą własną użytkownika.

Dispatcher jest napisany jako „zajmuj karty dopóki aktywnych < N", nie „weź jedną
i czekaj". Przy `N=1` zachowanie jest identyczne, kodu nie ma więcej, a podniesienie
limitu w fazie C nie będzie przepisywaniem dispatchera.

Koszt: zablokowany agent zatrzymuje kolejkę. Akceptowalny, bo eskalacja ma być
rzadka (sekcja 7). Parkowanie zablokowanych agentów (nie liczą się jako aktywne)
jest znanym rozwiązaniem, świadomie odłożonym.

## 6. Eskalacja

### Problem: heurystyka herdr tu nie wystarcza

Herdr wykrywa `blocked`/`idle` czytając zawartość panelu. Działa to dla agenta
stojącego na proście o uprawnienia — ale agent leci z bypassem, więc taki prompt
nigdy nie padnie. Claude kończy turę i czeka na input, a panel wygląda
**identycznie** niezależnie od tego, czy agent skończył zadanie, czy utknął.
Eskalacja oparta na samej heurystyce nie odróżniłaby sukcesu od zakleszczenia.

### Rozwiązanie: agent deklaruje stan jawnie

Orkiestrator kończy turę jedną z trzech linii:

```
@@FIESTA:ASK   <pytanie do człowieka>
@@FIESTA:DONE  <url draft PR>
@@FIESTA:FAIL  <powód>
```

Escalator nasłuchuje ich przez `herdr pane wait-output --regex`. To jest
deterministyczne — czytamy zadeklarowany stan, nie zgadujemy intencji z wyglądu
terminala.

**Heurystyka herdr zostaje jako watchdog.** Marker nie padnie, gdy agent umrze
inaczej niż przez zakończenie tury: crash, OOM, rate limit, zapętlenie. Panel
siedzi wtedy w `idle`/`blocked` bez markera i po przekroczeniu progu czasu
escalator zgłasza `FAIL`. Marker łapie znane stany, heurystyka łapie to, że agent
przestał mówić.

### Trzy sygnały, różne zachowania

| Marker | Znaczenie | Telegram | Karta |
|---|---|---|---|
| `ASK` | nie ruszę dalej bez ciebie | pyta, czeka na reply | `Blocked` |
| `FAIL` | zatrzymałem się, nic ode mnie nie potrzeba | informuje | `Blocked` |
| `DONE` | draft PR gotowy | informuje z linkiem | `Review` |

Mylenie `ASK` z `FAIL` zamieniłoby rzadkie pytania w strumień pingów.

### Korelacja bez stanu lokalnego

Wiadomość na Telegramie niesie `shortLink` karty. Użytkownik odpowiada przez
reply; Telegram dokleja oryginalną wiadomość, escalator wyciąga z niej
`shortLink`, znajduje workspace po labelu i robi `herdr pane send-text`.

Zero mapowań do utrzymania, zero pliku, który mógłby zginąć przy restarcie.
Źródłem prawdy o panelach jest herdr, o ticketach board.

### Degradacja

Gdy Telegram jest niedostępny, karta i tak ląduje w `Blocked` z komentarzem
zawierającym pytanie. Board jest kanałem zapasowym — awaria bota oznacza wolniejszą
reakcję, nie zgubiony ticket.

## 7. Skille

### `orchestrate-ticket`

Zrozum ticket → rozpoznaj repo (CLAUDE.md, testy, konwencje) → zaplanuj →
zaimplementuj → QA → push + draft PR → `DONE`.

**Subagenci domyślnie wyłączeni.** Wszyscy pracują w tym samym `/workspace`, więc
dwóch agentów edytujących ten sam obszar kodu nadpisze sobie zmiany — wspólny
katalog nie daje izolacji. Fan-out włączamy przy zadaniach **rozłącznych plikowo**
albo **read-only** (research, review, analiza). Dla typowego ticketu jeden nurt
pracy jest szybszy i tańszy niż koordynacja trzech.

Ponieważ fan-out nie jest ścieżką domyślną, **herdr-plus nie jest zależnością
MVP**. Herdr używamy do paneli, stanu i zdalnego dostępu; warstwę multi-agent
dokładamy, gdy będzie realnie potrzebna.

### Reguła autonomii

Agent ma być bardzo autonomiczny. Pytanie do człowieka jest wyjątkiem, nie
narzędziem rozwiewania wątpliwości. Test dwuetapowy:

1. **Czy da się to ustalić samodzielnie?** Z kodu, testów, historii gita,
   CLAUDE.md, konwencji repo, opisu karty. Jeśli tak — **ustal i rób**. To pokrywa
   nazewnictwo, układ plików, wybór spośród obecnych bibliotek, interpretację
   niedopowiedzianego edge case'a, ocenę „czy to dobre podejście".
2. **Nie da się — czy zła decyzja jest odwracalna w review?** Jeśli tak —
   **zdecyduj, rób, zapisz jako założenie w opisie PR-a**. Jeśli nie — pieniądze,
   dane produkcyjne, bezpieczeństwo, coś wysłanego w świat, coś czego nie cofnie
   `git reset` — **pytaj**.

`ASK` zostaje więc na rzeczach, których agent fizycznie nie ma jak zdobyć:
brakujący dostęp lub credential, intencja biznesowa nieobecna w kodzie, sprzeczny
ticket przy nieodwracalnych skutkach obu odczytań, akcja wymagająca człowieka.

Gdy pytanie i tak się pojawi, ma paść **na starcie, nie na końcu**: niejednoznaczny
ticket kosztuje jedno pytanie przed pracą albo czterdzieści minut roboty do
wyrzucenia.

**Sekcja „Założenia" w opisie PR jest obowiązkowa.** Wysoka autonomia bez niej
znaczy „agent zgadł i nikt się nie dowiedział". Z nią każde zgadnięcie jest jawne
i wyłapywane w review.

### `verify-ticket`

Generyczne QA: wykryj komendy testów/lintu/typechecku z repo, odpal je, a potem
przejdź po **kryteriach akceptacji z karty jeden po drugim**, przypisując każdemu
PASS/FAIL z dowodem.

Twarde warunki:
- Żadnego „przeszło" bez wklejonego outputu komendy.
- Żadnego PR-a z czerwonymi testami. Czerwono i nie umie naprawić → `FAIL`.

Przy braku człowieka patrzącego na ekran to jedyne zabezpieczenie przed agentem,
który uzna, że chyba działa.

Agent `QA` z repo tsoft nie przenosi się tutaj — jest zrośnięty z platformą
(curl/grpcurl, MCP do MySQL, ClickUp). Wróci w fazie C.

## 8. Awarie i odzyskiwanie

**Restart serwera.** Herdr odtwarza sesje, ale kontener ticketu nie żyje, a agent
zgubił kontekst rozmowy. Nie udajemy, że da się to wznowić: dispatcher przy
starcie znajduje karty w `In Progress` bez żywego workspace'a, przenosi je do
`Ready` i komentuje przyczynę. Praca leci od nowa, gałąź jest ta sama
(deterministyczna nazwa), więc nic nie ginie.

**Awaria daemona.** Bezstanowy — restart wystarcza. Karty w `In Progress`
z żywym workspace'em zostają nietknięte, reszta wraca do `Ready`.

**Agent zapętlony.** Twardy timeout na ticket (domyślnie 60 min bez markera i bez
zmiany stanu panelu) → `FAIL`, karta do `Blocked`, panel zostaje. Bez tego jeden
zapętlony agent zje limity subskrypcji do zera, a użytkownik dowie się o tym
z braku odpowiedzi Claude'a przy własnej pracy.

**Timeout nie biegnie po `ASK`.** Agent czekający na odpowiedź człowieka jest
w stanie prawidłowym i może w nim stać dowolnie długo — potraktowanie tego jako
zapętlenia zabijałoby sesje w nocy i zamieniało pytania w `FAIL`. Zegar rusza
ponownie dopiero po wstrzyknięciu odpowiedzi.

## 9. Testowanie

Trzy poziomy, każdy łapie co innego:

1. **Jednostkowo — kontrakty.** Parsowanie karty, wyciąganie markerów z outputu,
   mapowanie kolumn na stany. Czysty tekst, zero infrastruktury.
2. **Integracyjnie — atrapy.** Dispatcher i escalator przeciwko podstawionemu CLI
   herdr i API Trello. Tu łapiemy błędy przejść stanów bez palenia tokenów.
3. **Jeden e2e na żywo.** Realna karta, realny agent, trywialne zadanie („dodaj
   plik `HELLO.md`") aż do draft PR-a. Jedyny test, który dowodzi, że pętla działa;
   reszta dowodzi, że jej nie zepsuliśmy.

Świadomie **nie** piszemy testów na sam skill — zachowania LLM-a nie zamrozi się
w asercji. Skill walidujemy tym e2e i obserwacją pierwszych ticketów.

## 10. Sekrety i konfiguracja

Wszystko w `.env` na serwerze, poza repo. Zbierane i weryfikowane przez
`fiesta setup` — użytkownik nie tworzy tego pliku ręcznie.

| Sekret | Do czego |
|---|---|
| `TRELLO_API_KEY` | odczyt i zapis boardu |
| `TRELLO_TOKEN` | **nie OAuth secret** — token generowany raz przez `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<key>` |
| `TELEGRAM_BOT_TOKEN` | bot pingujący |
| `TELEGRAM_CHAT_ID` | odbiorca |
| `GITHUB_TOKEN` | push i draft PR, scope `repo` |
| poświadczenia Claude | montowane read-only do kontenera |

Konfiguracja: `TRELLO_BOARD_ID`, `GITHUB_OWNER`, id kolumn (rozwiązane raz przez
setup, nie po nazwie w czasie działania), `MAX_ACTIVE` (1), `TICKET_TIMEOUT`
(60 min), `POLL_INTERVAL` (30 s), korzeń `/mnt/user/appdata/fiesta`.

## 11. Świadomie poza MVP

- Webhooki Trello zamiast pollingu.
- Parkowanie zablokowanych agentów i równoległe tickety.
- Reakcja na edycję karty w trakcie pracy.
- QA specyficzne dla tsoft (żywa baza, grpcurl).
- Automatyczny merge — agent kończy na draft PR.

## 12. Otwarte na fazę A/C

- Sposób trwałej instalacji herdr na Unraidzie (kontener vs user-script).
- Klon vs worktree dla dużych repo.
- Dostęp agentów do stacku tsoft i izolacja portów przy wielu środowiskach.
