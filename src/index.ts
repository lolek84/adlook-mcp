#!/usr/bin/env node
/**
 * Adlook Smart API — Custom Reports Previews
 * MCP Server
 *
 * Narzędzia:
 *   create_report_preview  – POST /api/custom-reports/previews
 *   get_report_preview     – GET  /api/custom-reports/previews/{uuid}
 *   run_report_preview     – POST + polling GET aż do SUCCEEDED / FAILED
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "crypto";

// ── Stałe ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.ADLOOK_BASE_URL ?? "https://api.uat.smart.adlook.com/api";
const BEARER_TOKEN = process.env.ADLOOK_TOKEN ?? "";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

// ── Katalog metryk (z opisami) ───────────────────────────────────────────────

interface MetricDef {
  code: string;
  name: string;
  description: string;
  group: string;
}

const METRICS_CATALOG: MetricDef[] = [
  // AUDIO
  { code: "AUDIO_COMPLETE_LISTENS", name: "Audio Complete Listens", description: "The number of times an audio ad was played to the defined completion goal.", group: "AUDIO" },
  { code: "AUDIO_COMPLETION_RATE", name: "Audio Completion Rate", description: "The percentage of audio impressions that reached the defined completion goal. Calculated as (Audio Completed Listens ÷ Audio Impressions) × 100.", group: "AUDIO" },
  { code: "AUDIO_MUTES", name: "Audio Mutes", description: "The number of times an audio ad was muted.", group: "AUDIO" },
  { code: "AUDIO_PAUSES", name: "Audio Pauses", description: "The number of times an audio ad was paused.", group: "AUDIO" },
  { code: "AUDIO_PLAYS_25", name: "Audio Plays 25%", description: "The number of times 25% of the audio ad was played.", group: "AUDIO" },
  { code: "AUDIO_PLAYS_50", name: "Audio Plays 50%", description: "The number of times 50% of the audio ad was played.", group: "AUDIO" },
  { code: "AUDIO_PLAYS_75", name: "Audio Plays 75%", description: "The number of times 75% of the audio ad was played.", group: "AUDIO" },
  { code: "AUDIO_PLAYS_100", name: "Audio Plays 100%", description: "The number of times the audio ad was played in full.", group: "AUDIO" },
  { code: "AUDIO_RESUMES", name: "Audio Resumes", description: "The number of times a paused audio ad was resumed.", group: "AUDIO" },
  { code: "AUDIO_SKIPS", name: "Audio Skips", description: "The number of times an audio ad was skipped before reaching completion.", group: "AUDIO" },
  { code: "AUDIO_STARTS", name: "Audio Starts", description: "The number of times an audio ad started playing.", group: "AUDIO" },
  { code: "AUDIO_UNMUTES", name: "Audio Unmutes", description: "The number of times a muted audio ad was unmuted.", group: "AUDIO" },
  // CONVERSIONS
  { code: "CLICK_CONVERSION_RATE", name: "Click Conversion Rate", description: "The percentage of clicks that resulted in a post-click conversion. Calculated as (Post-click Conversions ÷ Clicks) × 100.", group: "CONVERSIONS" },
  { code: "CONVERSION_RATE", name: "Conversion Rate", description: "The percentage of impressions that resulted in a conversion. Calculated as (Total Conversions ÷ Impressions) × 100.", group: "CONVERSIONS" },
  { code: "CONVERSION_VALUE_ADVERTISER_CURRENCY", name: "Conversion Value (Advertiser Currency)", description: "The total value generated from conversions, reported in the advertiser's currency.", group: "CONVERSIONS" },
  { code: "CONVERSION_VALUE_USD", name: "Conversion Value (USD)", description: "The total value generated from conversions, reported in US dollars.", group: "CONVERSIONS" },
  { code: "POST_CLICK_CONVERSIONS", name: "Post-click Conversions", description: "The number of conversions that occurred after a user clicked the ad.", group: "CONVERSIONS" },
  { code: "POST_VIEW_CONVERSIONS", name: "Post-view Conversions", description: "The number of conversions that occurred after an ad impression, without a click.", group: "CONVERSIONS" },
  { code: "ROAS", name: "ROAS", description: "Return on Ad Spend. The revenue generated for each unit of spend. Calculated as (Conversion Value ÷ Total Spend).", group: "CONVERSIONS" },
  { code: "ROI", name: "ROI", description: "Return on Investment. The percentage return generated relative to the total spend. Calculated as ((Conversion Value − Total Spend) ÷ Total Spend) × 100.", group: "CONVERSIONS" },
  { code: "TOTAL_CONVERSIONS", name: "Total Conversions", description: "The total number of conversions attributed to the selected entity, including both post-click and post-view conversions.", group: "CONVERSIONS" },
  { code: "VIEW_THROUGH_CONVERSION_RATE", name: "View-through Conversion Rate", description: "The percentage of impressions that resulted in a post-view conversion. Calculated as (Post-view Conversions ÷ Impressions) × 100.", group: "CONVERSIONS" },
  // COST
  { code: "ECPA_ADVERTISER_CURRENCY", name: "eCPA (Advertiser Currency)", description: "The effective cost per conversion in the advertiser's currency. Calculated as (Total Spend ÷ Conversions).", group: "COST" },
  { code: "ECPA_USD", name: "eCPA (USD)", description: "The effective cost per conversion in US dollars. Calculated as (Total Spend ÷ Conversions).", group: "COST" },
  { code: "ECPA_PC_ADVERTISER_CURRENCY", name: "eCPA PC (Advertiser Currency)", description: "The effective cost per post-click conversion in the advertiser's currency. Calculated as (Total Spend ÷ Post-click Conversions).", group: "COST" },
  { code: "ECPA_PC_USD", name: "eCPA PC (USD)", description: "The effective cost per post-click conversion in US dollars. Calculated as (Total Spend ÷ Post-click Conversions).", group: "COST" },
  { code: "ECPA_PV_ADVERTISER_CURRENCY", name: "eCPA PV (Advertiser Currency)", description: "The effective cost per post-view conversion in the advertiser's currency. Calculated as (Total Spend ÷ Post-view Conversions).", group: "COST" },
  { code: "ECPA_PV_USD", name: "eCPA PV (USD)", description: "The effective cost per post-view conversion in US dollars. Calculated as (Total Spend ÷ Post-view Conversions).", group: "COST" },
  { code: "ECPC_ADVERTISER_CURRENCY", name: "eCPC (Advertiser Currency)", description: "The effective cost per click in the advertiser's currency. Calculated as (Total Spend ÷ Clicks).", group: "COST" },
  { code: "ECPC_USD", name: "eCPC (USD)", description: "The effective cost per click in US dollars. Calculated as (Total Spend ÷ Clicks).", group: "COST" },
  { code: "ECPCL_ADVERTISER_CURRENCY", name: "eCPCL (Advertiser Currency)", description: "The effective cost per completed audio listen in the advertiser's currency. Calculated as (Total Spend ÷ Completed Listens).", group: "COST" },
  { code: "ECPCL_USD", name: "eCPCL (USD)", description: "The effective cost per completed audio listen in US dollars. Calculated as (Total Spend ÷ Completed Listens).", group: "COST" },
  { code: "ECPCV_ADVERTISER_CURRENCY", name: "eCPCV (Advertiser Currency)", description: "The effective cost per completed video view in the advertiser's currency. Calculated as (Total Spend ÷ Completed Views).", group: "COST" },
  { code: "ECPCV_USD", name: "eCPCV (USD)", description: "The effective cost per completed video view in US dollars. Calculated as (Total Spend ÷ Completed Views).", group: "COST" },
  { code: "ECPLPV_ADVERTISER_CURRENCY", name: "eCPLPV (Advertiser Currency)", description: "The effective cost per landing page view in the advertiser's currency. Calculated as (Total Spend ÷ Landing Page Views).", group: "COST" },
  { code: "ECPLPV_USD", name: "eCPLPV (USD)", description: "The effective cost per landing page view in US dollars. Calculated as (Total Spend ÷ Landing Page Views).", group: "COST" },
  { code: "ECPM_ADVERTISER_CURRENCY", name: "eCPM (Advertiser Currency)", description: "The effective cost per 1,000 impressions in the advertiser's currency. Calculated as (Total Spend ÷ Impressions) × 1,000.", group: "COST" },
  { code: "ECPM_USD", name: "eCPM (USD)", description: "The effective cost per 1,000 impressions in US dollars. Calculated as (Total Spend ÷ Impressions) × 1,000.", group: "COST" },
  { code: "TOTAL_SPEND_ADVERTISER_CURRENCY", name: "Total Spend (Advertiser Currency)", description: "The total cost of media in the advertiser's currency.", group: "COST" },
  { code: "TOTAL_SPEND_USD", name: "Total Spend (USD)", description: "The total cost of media in US dollars.", group: "COST" },
  { code: "VCPM_ADVERTISER_CURRENCY", name: "vCPM (Advertiser Currency)", description: "The cost per 1,000 viewable impressions in the advertiser's currency. Calculated as (Total Spend ÷ Viewable Impressions) × 1,000.", group: "COST" },
  { code: "VCPM_USD", name: "vCPM (USD)", description: "The cost per 1,000 viewable impressions in US dollars. Calculated as (Total Spend ÷ Viewable Impressions) × 1,000.", group: "COST" },
  // PAGE_VISITS
  { code: "LANDING_PAGE_VIEWS", name: "Landing Page Views", description: "The number of clicks that successfully resulted in a page load on the advertiser's website.", group: "PAGE_VISITS" },
  { code: "LANDING_RATE", name: "Landing Rate", description: "The percentage of clicks that resulted in a successful page load on the advertiser's website. Calculated as (Landing Page Views ÷ Clicks) × 100.", group: "PAGE_VISITS" },
  // PERFORMANCE
  { code: "CLICK_THROUGH_RATE", name: "Click-through Rate", description: "The percentage of impressions that resulted in a click. Calculated as (Clicks ÷ Impressions) × 100.", group: "PERFORMANCE" },
  { code: "CLICKS", name: "Clicks", description: "The number of times an ad was clicked.", group: "PERFORMANCE" },
  { code: "CLICKS_SHARE", name: "Clicks Share", description: "The percentage of total clicks delivered that were attributed to the selected entity. Calculated as (Entity Clicks ÷ Total Clicks) × 100.", group: "PERFORMANCE" },
  { code: "IMPRESSIONS", name: "Impressions", description: "The number of times an ad was rendered.", group: "PERFORMANCE" },
  { code: "IMPRESSIONS_SHARE", name: "Impressions Share", description: "The percentage of total impressions delivered that were attributed to the selected entity. Calculated as (Entity Impressions ÷ Total Impressions) × 100.", group: "PERFORMANCE" },
  { code: "MEASURABILITY", name: "Measurability", description: "The percentage of impressions that were measurable for viewability. Calculated as (Measurable Impressions ÷ Impressions) × 100.", group: "PERFORMANCE" },
  { code: "MEASURABLE_IMPRESSIONS", name: "Measurable Impressions", description: "The number of impressions where viewability measurement was possible.", group: "PERFORMANCE" },
  { code: "VIEWABILITY", name: "Viewability", description: "The percentage of measurable impressions that were viewable. Calculated as (Viewable Impressions ÷ Measurable Impressions) × 100.", group: "PERFORMANCE" },
  { code: "VIEWABLE_IMPRESSIONS", name: "Viewable Impressions", description: "The number of impressions that met the IAB viewability standard.", group: "PERFORMANCE" },
  // UNIQUES
  { code: "FREQUENCY", name: "Frequency", description: "The average number of ad exposures per individual.", group: "UNIQUES" },
  { code: "REACH", name: "Reach", description: "The number of unique individuals who were exposed to an ad during the reporting period.", group: "UNIQUES" },
  // VIDEO
  { code: "VIDEO_COMPLETE_VIEWS", name: "Video Complete Views", description: "The number of times a video ad was viewed to the defined completion goal.", group: "VIDEO" },
  { code: "VIDEO_COMPLETION_RATE", name: "Video Completion Rate", description: "The percentage of video impressions that reached the defined completion goal. Calculated as (Video Completed Views ÷ Video Impressions) × 100.", group: "VIDEO" },
  { code: "VIDEO_ERRORS", name: "Video Errors", description: "The number of times an error occurred during video playback, preventing the ad from playing as intended.", group: "VIDEO" },
  { code: "VIDEO_EXPANDS", name: "Video Expands", description: "The number of times a video ad was expanded.", group: "VIDEO" },
  { code: "VIDEO_MUTES", name: "Video Mutes", description: "The number of times a video ad was muted.", group: "VIDEO" },
  { code: "VIDEO_PAUSES", name: "Video Pauses", description: "The number of times a video ad was paused.", group: "VIDEO" },
  { code: "VIDEO_PLAYS_25", name: "Video Plays 25%", description: "The number of times 25% of the video was played.", group: "VIDEO" },
  { code: "VIDEO_PLAYS_50", name: "Video Plays 50%", description: "The number of times 50% of the video was played.", group: "VIDEO" },
  { code: "VIDEO_PLAYS_75", name: "Video Plays 75%", description: "The number of times 75% of the video was played.", group: "VIDEO" },
  { code: "VIDEO_PLAYS_100", name: "Video Plays 100%", description: "The number of times the video was played in full.", group: "VIDEO" },
  { code: "VIDEO_RESUMES", name: "Video Resumes", description: "The number of times a paused video ad was resumed.", group: "VIDEO" },
  { code: "VIDEO_SKIPS", name: "Video Skips", description: "The number of times a video ad was skipped.", group: "VIDEO" },
  { code: "VIDEO_STARTS", name: "Video Starts", description: "The number of times a video ad started playing.", group: "VIDEO" },
  { code: "VIDEO_UNMUTES", name: "Video Unmutes", description: "The number of times a muted video ad was unmuted.", group: "VIDEO" },
];

// Indeks dla szybkiego wyszukiwania po kodzie
const METRICS_BY_CODE = new Map<string, MetricDef>(
  METRICS_CATALOG.map((m) => [m.code, m])
);

// ── Dozwolone wartości (z OpenAPI enum) ──────────────────────────────────────

const DIMENSION_CODES = [
  "DATE","WEEK","MONTH","YEAR",
  "CITY","REGION","COUNTRY","POSTAL_CODE",
  "DEVICE_TYPE","BROWSER","OPERATING_SYSTEM","ENVIRONMENT",
  "CLIENT_NAME","PROFIT_CENTER",
  "ADVERTISER_NAME","ADVERTISER_UUID","ADVERTISER_ID","ADVERTISER_HASH",
  "ADVERTISER_COUNTRY","BUSINESS_GROUP","BRAND","ADVERTISER_CURRENCY",
  "VERTICAL","ADVERTISER_TIME_ZONE",
  "CAMPAIGN_NAME","CAMPAIGN_OBJECTIVE","CAMPAIGN_BUDGET",
  "CAMPAIGN_START_DATE","CAMPAIGN_END_DATE","CAMPAIGN_STATUS",
  "LINE_ITEM_NAME","LINE_ITEM_TYPE","LINE_ITEM_BUDGET","LINE_ITEM_GROUP_NAME",
  "LINE_ITEM_START_DATE","LINE_ITEM_END_DATE","LINE_ITEM_BIDDING_MODEL",
  "LINE_ITEM_PRIMARY_GOAL_NAME","LINE_ITEM_SECONDARY_GOAL_NAME","LINE_ITEM_TERTIARY_GOAL_NAME",
  "LINE_ITEM_PRIMARY_GOAL_VALUE","LINE_ITEM_SECONDARY_GOAL_VALUE","LINE_ITEM_TERTIARY_GOAL_VALUE",
  "SUBCAMPAIGN_ID","SUBCAMPAIGN_HASH","SUBCAMPAIGN_CLIENTS_GROUP","LINE_ITEM_STATUS",
  "CREATIVE_NAME","CREATIVE_HASH","CREATIVE_ID","CREATIVE_TYPE",
  "CREATIVE_LINE","CREATIVE_SIZE","CREATIVE_DURATION",
  "DOMAIN","TOP_LEVEL_DOMAIN","APP_NAME","APP_ID","SUPPLY_SOURCE",
] as const;

const METRIC_CODES = [
  "IMPRESSIONS","IMPRESSIONS_SHARE","VIEWABLE_IMPRESSIONS","MEASURABLE_IMPRESSIONS",
  "MEASURABILITY","VIEWABILITY","CLICKS","CLICKS_SHARE","CLICK_THROUGH_RATE",
  "REACH","FREQUENCY",
  "AUDIO_COMPLETE_LISTENS","AUDIO_COMPLETION_RATE","AUDIO_STARTS",
  "AUDIO_PLAYS_25","AUDIO_PLAYS_50","AUDIO_PLAYS_75","AUDIO_PLAYS_100",
  "AUDIO_PAUSES","AUDIO_RESUMES","AUDIO_MUTES","AUDIO_UNMUTES","AUDIO_SKIPS",
  "VIDEO_COMPLETE_VIEWS","VIDEO_COMPLETION_RATE","VIDEO_STARTS",
  "VIDEO_PLAYS_25","VIDEO_PLAYS_50","VIDEO_PLAYS_75","VIDEO_PLAYS_100",
  "VIDEO_PAUSES","VIDEO_RESUMES","VIDEO_MUTES","VIDEO_UNMUTES","VIDEO_SKIPS",
  "VIDEO_EXPANDS","VIDEO_ERRORS",
  "TOTAL_CONVERSIONS","LANDING_PAGE_VIEWS","LANDING_RATE","CONVERSION_RATE",
  "VIEW_THROUGH_CONVERSION_RATE","CLICK_CONVERSION_RATE",
  "POST_VIEW_CONVERSIONS","POST_CLICK_CONVERSIONS",
  "CONVERSION_VALUE_USD","CONVERSION_VALUE_ADVERTISER_CURRENCY","ROI","ROAS",
  "TOTAL_SPEND_USD","TOTAL_SPEND_ADVERTISER_CURRENCY",
  "ECPM_USD","VCPM_USD","ECPC_USD","ECPA_USD","ECPA_PV_USD","ECPA_PC_USD",
  "ECPCV_USD","ECPLPV_USD","ECPCL_USD",
  "ECPM_ADVERTISER_CURRENCY","VCPM_ADVERTISER_CURRENCY","ECPC_ADVERTISER_CURRENCY",
  "ECPA_ADVERTISER_CURRENCY","ECPA_PV_ADVERTISER_CURRENCY","ECPA_PC_ADVERTISER_CURRENCY",
  "ECPCV_ADVERTISER_CURRENCY","ECPLPV_ADVERTISER_CURRENCY","ECPCL_ADVERTISER_CURRENCY",
] as const;

const FILTER_FIELDS = ["ADVERTISER_UUID", "CLIENT_UUID"] as const;

// ── Schematy Zod (wejście narzędzi) ──────────────────────────────────────────

const FilterSchema = z.object({
  field: z.enum(FILTER_FIELDS).describe("Pole filtrowania: ADVERTISER_UUID lub CLIENT_UUID"),
  value: z.array(z.string().uuid()).min(1).describe("Lista UUID encji"),
});

const ReportRequestSchema = {
  dimensions: z
    .array(z.enum(DIMENSION_CODES))
    .min(1)
    .describe("Lista wymiarów raportu (min. 1)"),
  metrics: z
    .array(z.enum(METRIC_CODES))
    .optional()
    .describe("Lista metryk raportu (opcjonalna)"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD")
    .describe("Data początku okresu (YYYY-MM-DD, max 185 dni wstecz)"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD")
    .describe("Data końca okresu (YYYY-MM-DD, >= start_date)"),
  filters: z
    .array(FilterSchema)
    .optional()
    .describe("Opcjonalne filtry (ADVERTISER_UUID / CLIENT_UUID)"),
};

// ── Pomocniki HTTP ────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  if (!BEARER_TOKEN) {
    throw new Error(
      "Brak tokenu autoryzacyjnego. Ustaw zmienną środowiskową ADLOOK_TOKEN."
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${BEARER_TOKEN}`,
  };
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

// ── Polling ───────────────────────────────────────────────────────────────────

interface ReportPreview {
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>[] | null;
  total_rows: number | null;
}

async function pollUntilDone(
  uuid: string,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS
): Promise<ReportPreview> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const preview = (await apiGet(
      `/custom-reports/previews/${uuid}`
    )) as ReportPreview;

    if (preview.status === "SUCCEEDED" || preview.status === "FAILED") {
      return preview;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Timeout: zadanie ${uuid} nie zakończyło się w ciągu ${timeoutMs / 1000}s`
  );
}

// ── MCP Server ────────────────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "adlook-custom-reports",
    version: "1.0.0",
  });

// ── Narzędzie 1: create_report_preview ───────────────────────────────────────

server.tool(
  "create_report_preview",
  "Tworzy asynchroniczne zadanie generowania podglądu raportu (POST /api/custom-reports/previews). " +
    "Zwraca UUID zadania. Wynik należy pobrać narzędziem get_report_preview lub run_report_preview.",
  ReportRequestSchema,
  async (args) => {
    try {
      const result = await apiPost("/custom-reports/previews", args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Błąd: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Narzędzie 2: get_report_preview ──────────────────────────────────────────

server.tool(
  "get_report_preview",
  "Pobiera aktualny stan podglądu raportu (GET /api/custom-reports/previews/{uuid}). " +
    "Status PENDING oznacza, że zadanie jest jeszcze przetwarzane.",
  {
    uuid: z
      .string()
      .uuid()
      .describe("UUID podglądu zwrócony przez create_report_preview"),
  },
  async ({ uuid }) => {
    try {
      const result = await apiGet(`/custom-reports/previews/${uuid}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Błąd: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Narzędzie 3: run_report_preview ──────────────────────────────────────────

server.tool(
  "run_report_preview",
  "Tworzy podgląd raportu i czeka (polling) aż zadanie osiągnie status SUCCEEDED lub FAILED. " +
    "Łączy create_report_preview + get_report_preview w jednym wywołaniu. " +
    "Parametry poll_interval_ms i poll_timeout_ms kontrolują częstotliwość i maksymalny czas oczekiwania.",
  {
    ...ReportRequestSchema,
    poll_interval_ms: z
      .number()
      .int()
      .min(500)
      .optional()
      .describe(`Interval pollingu w ms (domyślnie ${DEFAULT_POLL_INTERVAL_MS})`),
    poll_timeout_ms: z
      .number()
      .int()
      .min(1000)
      .optional()
      .describe(`Maksymalny czas oczekiwania w ms (domyślnie ${DEFAULT_POLL_TIMEOUT_MS})`),
  },
  async ({ poll_interval_ms, poll_timeout_ms, ...reportArgs }) => {
    try {
      // 1. Utwórz zadanie
      const created = (await apiPost(
        "/custom-reports/previews",
        reportArgs
      )) as { uuid: string };

      const uuid = created.uuid;

      // 2. Polling
      const preview = await pollUntilDone(
        uuid,
        poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS,
        poll_timeout_ms ?? DEFAULT_POLL_TIMEOUT_MS
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ uuid, ...preview }, null, 2),
          },
        ],
        isError: preview.status === "FAILED",
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Błąd: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Narzędzie 4: list_metrics ────────────────────────────────────────────────

server.tool(
  "list_metrics",
  "Zwraca pełną listę dostępnych metryk z nazwami, opisami i grupami. " +
    "Używaj tego narzędzia, gdy chcesz dowiedzieć się co oznacza dana metryka, " +
    "lub gdy potrzebujesz wybrać odpowiednie metryki do raportu. " +
    "Możesz filtrować po grupie: AUDIO, VIDEO, PERFORMANCE, CONVERSIONS, COST, PAGE_VISITS, UNIQUES.",
  {
    group: z
      .enum(["AUDIO", "VIDEO", "PERFORMANCE", "CONVERSIONS", "COST", "PAGE_VISITS", "UNIQUES"])
      .optional()
      .describe("Opcjonalne filtrowanie po grupie metryk"),
    search: z
      .string()
      .optional()
      .describe("Opcjonalne wyszukiwanie po nazwie lub opisie metryki (case-insensitive)"),
  },
  async ({ group, search }) => {
    let results = METRICS_CATALOG;

    if (group) {
      results = results.filter((m) => m.group === group);
    }

    if (search) {
      const q = search.toLowerCase();
      results = results.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.code.toLowerCase().includes(q)
      );
    }

    const grouped = results.reduce<Record<string, MetricDef[]>>((acc, m) => {
      (acc[m.group] ??= []).push(m);
      return acc;
    }, {});

    const output = Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([grp, metrics]) => ({
        group: grp,
        metrics: metrics.map((m) => ({
          code: m.code,
          name: m.name,
          description: m.description,
        })),
      }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { total: results.length, groups: output },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Zasób MCP: katalog metryk ─────────────────────────────────────────────────

server.resource(
  "metrics-catalog",
  "adlook://metrics-catalog",
  {
    description:
      "Pełny katalog metryk dostępnych w Adlook Custom Reports, " +
      "wraz z nazwami, opisami i przynależnością do grup " +
      "(AUDIO, VIDEO, PERFORMANCE, CONVERSIONS, COST, PAGE_VISITS, UNIQUES).",
    mimeType: "application/json",
  },
  async () => ({
    contents: [
      {
        uri: "adlook://metrics-catalog",
        mimeType: "application/json",
        text: JSON.stringify(METRICS_CATALOG, null, 2),
      },
    ],
  })
);

  return server;
}

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000");
const MODE = process.env.MCP_TRANSPORT ?? "http"; // "http" | "stdio"

if (MODE === "stdio") {
  // Lokalny tryb stdio (np. testowanie z terminala)
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  // Tryb HTTP/SSE dla deploymentu zespołowego
  const app = express();
  app.use(express.json());

  // Mapa sesji SSE: sessionId → transport
  const sseSessions = new Map<string, SSEServerTransport>();

  // SSE endpoint — klient łączy się tutaj i trzyma połączenie otwarte
  app.get("/sse", async (req, res) => {
    console.log("[MCP] Nowe połączenie SSE");
    try {
      const transport = new SSEServerTransport("/message", res);
      sseSessions.set(transport.sessionId, transport);
      console.log(`[MCP] Sesja SSE: ${transport.sessionId}`);

      transport.onclose = () => {
        console.log(`[MCP] Sesja SSE zamknięta: ${transport.sessionId}`);
        sseSessions.delete(transport.sessionId);
      };

      const sessionServer = createServer();
      await sessionServer.connect(transport);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Błąd SSE: ${message}`);
      if (!res.headersSent) res.status(500).end();
    }
  });

  // Message endpoint — klient wysyła wiadomości tutaj
  app.post("/message", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseSessions.get(sessionId);

    if (!transport) {
      console.warn(`[MCP] Nieznany sessionId: ${sessionId}`);
      res.status(400).json({ error: `Nieznana sesja: ${sessionId}` });
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Błąd /message (sesja: ${sessionId}): ${message}`);
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "adlook-custom-reports",
      version: "1.0.0",
      sessions: sseSessions.size,
      uptime: Math.floor(process.uptime()),
    });
  });

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[MCP] Nieobsłużony błąd: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  });

  process.on("uncaughtException", (err) => {
    console.error(`[MCP] uncaughtException: ${err.message}`, err.stack);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`[MCP] unhandledRejection:`, reason);
  });

  app.listen(PORT, () => {
    console.log(`Adlook MCP Server uruchomiony na porcie ${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}