# Adlook Custom Reports MCP Server

Serwer MCP dla Adlook Smart API — endpoint `/api/custom-reports/previews`.

## Wymagania

- Node.js 18+
- Token Bearer do Adlook Smart API

## Instalacja

```bash
npm install
npm run build
```

## Konfiguracja

Ustaw zmienne środowiskowe przed uruchomieniem:

| Zmienna           | Opis                                  | Domyślna                                   |
|-------------------|---------------------------------------|--------------------------------------------|
| `ADLOOK_TOKEN`    | JWT Bearer token (wymagany)           | —                                          |
| `ADLOOK_BASE_URL` | Bazowy URL API                        | `https://api.uat.smart.adlook.com/api`     |

## Uruchomienie

```bash
ADLOOK_TOKEN=<twój_token> node dist/index.js
```

## Konfiguracja w kliencie MCP (np. Claude Desktop)

```json
{
  "mcpServers": {
    "adlook-custom-reports": {
      "command": "node",
      "args": ["/ścieżka/do/adlook-mcp/dist/index.js"],
      "env": {
        "ADLOOK_TOKEN": "<twój_token>"
      }
    }
  }
}
```

---

## Dostępne narzędzia

### `create_report_preview`

Tworzy asynchroniczne zadanie generowania raportu (`POST /api/custom-reports/previews`).  
Zwraca `uuid` zadania.

**Parametry:**

| Parametr     | Typ                  | Wymagany | Opis                                        |
|--------------|----------------------|----------|---------------------------------------------|
| `dimensions` | `DimensionCode[]`    | ✅        | Lista wymiarów (min. 1)                     |
| `metrics`    | `MetricCode[]`       | ❌        | Lista metryk                                |
| `start_date` | `string` YYYY-MM-DD  | ✅        | Data początku (max 185 dni wstecz)          |
| `end_date`   | `string` YYYY-MM-DD  | ✅        | Data końca (>= start_date)                  |
| `filters`    | `Filter[]`           | ❌        | Filtry po ADVERTISER_UUID / CLIENT_UUID      |
| `adlook_token` | `string`           | ❌        | Token Bearer podany w argumencie narzędzia (nadpisuje env `ADLOOK_TOKEN`) |

**Przykład odpowiedzi:**
```json
{ "uuid": "3fa85f64-5717-4562-b3fc-2c963f66afa6" }
```

---

### `get_report_preview`

Pobiera aktualny stan zadania (`GET /api/custom-reports/previews/{uuid}`).

**Parametry:**

| Parametr | Typ    | Opis                       |
|----------|--------|----------------------------|
| `uuid`   | string | UUID zwrócony przez POST   |
| `adlook_token` | string | Opcjonalny token Bearer (nadpisuje env `ADLOOK_TOKEN`) |

**Możliwe statusy:** `PENDING` | `SUCCEEDED` | `FAILED`

---

### `run_report_preview`

Łączy `create_report_preview` + polling `get_report_preview` w jednym wywołaniu.  
Czeka aż zadanie osiągnie status `SUCCEEDED` lub `FAILED`.

**Parametry:** wszystkie z `create_report_preview` (w tym opcjonalny `adlook_token`) plus:

| Parametr           | Typ    | Domyślna | Opis                               |
|--------------------|--------|----------|------------------------------------|
| `poll_interval_ms` | number | `2000`   | Częstotliwość pollingu (min 500ms) |
| `poll_timeout_ms`  | number | `120000` | Maksymalny czas oczekiwania (ms)   |

---

## Wymiary (DimensionCode)

Czas: `DATE`, `WEEK`, `MONTH`, `YEAR`  
Lokalizacja: `CITY`, `REGION`, `COUNTRY`, `POSTAL_CODE`  
System: `DEVICE_TYPE`, `BROWSER`, `OPERATING_SYSTEM`, `ENVIRONMENT`  
Ogólne: `ADVERTISER_NAME`, `CAMPAIGN_NAME`, `LINE_ITEM_NAME`, `CREATIVE_NAME`, `DOMAIN`, ...

## Metryki (MetricCode)

Performance: `IMPRESSIONS`, `CLICKS`, `VIEWABILITY`, `CLICK_THROUGH_RATE`, ...  
Wideo: `VIDEO_COMPLETE_VIEWS`, `VIDEO_COMPLETION_RATE`, ...  
Audio: `AUDIO_COMPLETE_LISTENS`, `AUDIO_COMPLETION_RATE`, ...  
Konwersje: `TOTAL_CONVERSIONS`, `CONVERSION_RATE`, `ROI`, `ROAS`, ...  
Koszty: `TOTAL_SPEND_USD`, `ECPM_USD`, `ECPC_USD`, ...
