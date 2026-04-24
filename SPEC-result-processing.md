# Specyfikacja: Przetwarzanie wyników raportów po stronie MCP

## Kontekst

MCP pobiera dane raportowe z Adlook Smart API jako płaską tablicę wierszy (`Record<string, unknown>[]`). API nie udostępnia sortowania, filtrowania po dowolnych kolumnach ani limitowania wyników. Niniejsza specyfikacja opisuje warstwę post-processingu implementowaną po stronie MCP — po odebraniu odpowiedzi z API, przed zwróceniem danych klientowi.

Dotyczy narzędzi: **`run_report_preview`**, **`get_report_preview`**.

---

## Zakres zmian

### 1. Sortowanie (`sort`)

Użytkownik może posortować wyniki po dowolnej kolumnie (dimension lub metric), rosnąco lub malejąco. Sortowanie musi uwzględniać typ wartości w kolumnie.

#### Schemat parametru

```typescript
sort?: {
  column: string;        // nazwa kolumny, np. "IMPRESSIONS", "DATE"
  direction: "ASC" | "DESC";
}
```

#### Reguły implementacji

**Wykrywanie typu kolumny:**
- Typ wyznaczany jest na podstawie **pierwszej niepustej wartości** w kolumnie (`result.find(row => row[column] != null)`).
- Jeśli wartość po `Number(value)` nie jest `NaN` — traktuj jako **liczbę**.
- W przeciwnym razie traktuj jako **tekst** (porównanie z `localeCompare`).

**Algorytm sortowania:**

```
dla każdej pary wierszy (a, b):
  va = a[column], vb = b[column]

  // wartości null/undefined na końcu (niezależnie od kierunku)
  jeśli va == null i vb == null → równe
  jeśli va == null → b przed a
  jeśli vb == null → a przed b

  jeśli typ numeryczny:
    wynik = Number(va) - Number(vb)
  jeśli typ tekstowy:
    wynik = String(va).localeCompare(String(vb), undefined, { sensitivity: "base" })

  jeśli direction == "DESC": odwróć wynik
```

**Walidacja:**
- Jeśli `column` nie istnieje w żadnym wierszu — zwróć błąd: `"Kolumna '{column}' nie istnieje w wynikach raportu."`.
- Sortowanie stosowane **po filtrowaniu**, **przed limitowaniem**.

---

### 2. Filtrowanie REGEXP (`filters`)

Użytkownik może filtrować wiersze przy użyciu wyrażeń regularnych na dowolnych kolumnach. Filtry łączone są operatorami AND/OR z obsługą zagnieżdżania.

#### Schemat parametru

Parametr `filters` przyjmuje **drzewo warunków** (Condition Tree):

```typescript
// Liść REGEXP — dopasowanie tekstowe na dowolnej kolumnie
type FilterLeaf = {
  column: string;     // nazwa kolumny, np. "ADVERTISER_NAME"
  regexp: string;     // wyrażenie regularne, np. "^Acme" lub "Nike|Adidas"
  flags?: string;     // flagi JS RegExp, domyślnie "i" (case-insensitive)
};

// Liść RANGE — filtr numeryczny na zakres (kolumna musi być liczbą)
type FilterRange = {
  column: string;     // nazwa kolumny, np. "IMPRESSIONS"
  gt?: number;        // strictly greater than (>)
  gte?: number;       // greater than or equal (>=)
  lt?: number;        // strictly less than (<)
  lte?: number;       // less than or equal (<=)
};

// Węzeł AND — wszystkie warunki muszą być spełnione
type FilterAnd = {
  and: Condition[];
};

// Węzeł OR — wystarczy jeden warunek
type FilterOr = {
  or: Condition[];
};

type Condition = FilterLeaf | FilterRange | FilterAnd | FilterOr;

// Parametr narzędzia
result_filters?: Condition;
```

> **Uwaga:** Zmieniono nazwę na `result_filters`, aby odróżnić od istniejącego parametru `filters` (filtrowanie po stronie API: `ADVERTISER_UUID`, `CLIENT_UUID`).

#### Przykłady użycia

**Proste filtrowanie — jeden warunek:**
```json
{
  "result_filters": {
    "column": "ADVERTISER_NAME",
    "regexp": "Nike|Adidas",
    "flags": "i"
  }
}
```

**Filtr numeryczny — przedział:**
```json
{
  "result_filters": {
    "column": "IMPRESSIONS",
    "gte": 10000,
    "lt": 500000
  }
}
```

**Filtr numeryczny — tylko dolna granica (większy niż):**
```json
{
  "result_filters": {
    "column": "CLICK_THROUGH_RATE",
    "gt": 2.5
  }
}
```

**AND — wiele kolumn jednocześnie (REGEXP + RANGE):**
```json
{
  "result_filters": {
    "and": [
      { "column": "COUNTRY", "regexp": "^PL$" },
      { "column": "IMPRESSIONS", "gte": 10000 }
    ]
  }
}
```

**OR — alternatywne warunki:**
```json
{
  "result_filters": {
    "or": [
      { "column": "DEVICE_TYPE", "regexp": "mobile" },
      { "column": "ENVIRONMENT", "regexp": "app" }
    ]
  }
}
```

**Zagnieżdżone (AND + OR):**
```json
{
  "result_filters": {
    "and": [
      { "column": "COUNTRY", "regexp": "^PL$" },
      {
        "or": [
          { "column": "DEVICE_TYPE", "regexp": "mobile" },
          { "column": "DEVICE_TYPE", "regexp": "tablet" }
        ]
      }
    ]
  }
}
```

#### Reguły implementacji — FilterLeaf (REGEXP)

- Wartość każdej komórki konwertowana do `String(value)` przed dopasowaniem (obsługuje liczby, daty itp.).
- Wartości `null`/`undefined` traktowane jako pusty string `""`.
- Domyślna flaga: `"i"` (case-insensitive). Użytkownik może podać inne flagi JS (`g` ignorowana).
- Nieprawidłowe wyrażenie regularne → błąd: `"Nieprawidłowe wyrażenie regularne '{regexp}': {message}"`.
- Nieistniejąca kolumna w filtrze → wiersz **nie przechodzi** filtra (bezpieczne domyślne zachowanie).

#### Reguły implementacji — FilterRange (zakres numeryczny)

- Wyróżnik: obiekt zawiera pole `column` bez pola `regexp` (discriminant).
- Wartość komórki konwertowana przez `Number(value)`.
- Jeśli `Number(value)` jest `NaN` (kolumna nie jest liczbą lub wartość jest null) → wiersz **nie przechodzi** filtra.
- Warunki graniczne ewaluowane niezależnie i łączone jako AND między sobą:
  ```
  przechodzi = true
  jeśli gt  zdefiniowane: przechodzi &&= (val > gt)
  jeśli gte zdefiniowane: przechodzi &&= (val >= gte)
  jeśli lt  zdefiniowane: przechodzi &&= (val < lt)
  jeśli lte zdefiniowane: przechodzi &&= (val <= lte)
  ```
- Przynajmniej jedno z pól (`gt`, `gte`, `lt`, `lte`) musi być podane → błąd walidacji schematu Zod jeśli żadne nie jest.
- `gte` i `gt` mogą być podane jednocześnie — oba są stosowane (choć semantycznie wystarczy `gt`; pozostawiono użytkownikowi).
- Filtrowanie stosowane **przed sortowaniem** i **przed limitowaniem**.

---

### 3. Limitowanie wyników (`top`)

Użytkownik może ograniczyć liczbę zwróconych wierszy do N pierwszych (po filtrowaniu i sortowaniu).

#### Schemat parametru

```typescript
top?: number;   // liczba całkowita >= 1
```

#### Reguły implementacji

- Stosowane jako ostatnie: po filtrowaniu, po sortowaniu.
- `top: 10` → zwróć pierwsze 10 wierszy.
- Jeśli `top` > liczba dostępnych wierszy → zwróć wszystkie.
- `top <= 0` → błąd: `"Parametr 'top' musi być liczbą całkowitą >= 1."`.

---

## Kolejność operacji (pipeline)

```
Surowe dane z API (result[])
        ↓
1. Filtrowanie (result_filters)
        ↓
2. Sortowanie (sort)
        ↓
3. Limitowanie (top)
        ↓
Wynik zwracany klientowi
```

---

## Zmiany w odpowiedzi narzędzi

Odpowiedź wzbogacona o metadane przetwarzania:

```typescript
interface ReportPreviewResponse {
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>[] | null;
  total_rows: number | null;          // liczba wierszy z API (przed przetwarzaniem)

  // Nowe pola (obecne gdy status == "SUCCEEDED" i zastosowano przetwarzanie)
  filtered_rows?: number;             // liczba wierszy po filtrowaniu
  returned_rows?: number;             // liczba wierszy po limitowaniu (faktycznie zwrócone)
  processing_applied?: {
    filtered: boolean;
    sorted: boolean;
    limited: boolean;
  };
}
```

---

## Zmiany w schematach narzędzi

Parametry dodawane do schematów `run_report_preview` i `get_report_preview`:

```typescript
// Dodać do obu narzędzi:
result_filters: z.optional(conditionSchema),  // drzewo warunków filterowania
sort: z.optional(z.object({
  column: z.string(),
  direction: z.enum(["ASC", "DESC"]),
})),
top: z.optional(z.number().int().min(1)),
```

Gdzie `conditionSchema` to rekurencyjny schemat Zod dla drzewa `Condition`:

```typescript
const filterLeafSchema = z.object({
  column: z.string(),
  regexp: z.string(),
  flags: z.string().optional(),
});

const filterRangeSchema = z.object({
  column: z.string(),
  gt:  z.number().optional(),
  gte: z.number().optional(),
  lt:  z.number().optional(),
  lte: z.number().optional(),
}).refine(
  (v) => v.gt !== undefined || v.gte !== undefined || v.lt !== undefined || v.lte !== undefined,
  { message: "FilterRange wymaga przynajmniej jednej granicy (gt, gte, lt lub lte)" }
);

// Rekurencja przez z.lazy
const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    filterLeafSchema,
    filterRangeSchema,
    z.object({ and: z.array(conditionSchema).min(1) }),
    z.object({ or:  z.array(conditionSchema).min(1) }),
  ])
);
```

---

## Obsługa błędów

| Sytuacja | Zachowanie |
|---|---|
| Nieprawidłowe wyrażenie regularne | `isError: true`, komunikat z nazwą kolumny i błędem |
| FilterRange bez żadnej granicy (brak gt/gte/lt/lte) | błąd walidacji Zod przed wykonaniem |
| Wartość w kolumnie FilterRange nie jest liczbą / jest null | wiersz nie przechodzi filtra (bez błędu) |
| Kolumna sortowania nie istnieje w wynikach | `isError: true`, komunikat z nazwą kolumny |
| `top <= 0` | `isError: true`, komunikat |
| Pusty `result` z API (null lub []) | Pomijanie przetwarzania, zwrot bez błędu |
| Status raportu != SUCCEEDED | Pomijanie przetwarzania, zwrot oryginalnej odpowiedzi |

---

## Pliki do modyfikacji

| Plik | Zakres zmian |
|---|---|
| `src/index.ts` | Dodanie schematów Zod, logiki post-processingu, wzbogacenie odpowiedzi |

Nie planuje się zmian w `src/access-token.ts`, schematach API ani logice pollingu.

---

## Przykład wywołania (docelowy)

```json
{
  "tool": "run_report_preview",
  "arguments": {
    "dimensions": ["ADVERTISER_NAME", "DATE", "DEVICE_TYPE"],
    "metrics": ["IMPRESSIONS", "CLICKS"],
    "start_date": "2026-01-01",
    "end_date": "2026-03-31",
    "result_filters": {
      "and": [
        { "column": "DEVICE_TYPE", "regexp": "mobile|tablet", "flags": "i" },
        { "column": "ADVERTISER_NAME", "regexp": "^Nike" }
      ]
    },
    "sort": {
      "column": "IMPRESSIONS",
      "direction": "DESC"
    },
    "top": 20
  }
}
```

Semantyka: pobierz raport → zostaw tylko wiersze z urządzeniami mobile/tablet dla Nike → posortuj malejąco po impresji → zwróć top 20.
