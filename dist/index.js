#!/usr/bin/env node
/**
 * Adlook Smart API — Custom Reports Previews
 * MCP Server
 *
 * Narzędzia:
 *   set_adlook_auth        – tokeny z przeglądarki na sesję (pamięć procesu)
 *   check_auth             – sprawdza status tokenu (bez API call)
 *   list_advertisers       – lista advertiserów (name → UUID, z cache 1h)
 *   list_dimensions        – katalog wymiarów z opisami
 *   list_metrics           – katalog metryk z opisami
 *   create_report_preview  – POST /api/custom-reports/previews
 *   get_report_preview     – GET  /api/custom-reports/previews/{uuid}
 *   run_report_preview     – POST + polling GET + pełny post-processing
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import express from "express";
import { invalidateCachedAccessToken, isOAuthRefreshConfigured, resolveAccessToken, setSessionAuth, } from "./access-token.js";
// ── Stałe ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.ADLOOK_BASE_URL ?? "https://smart.adlook.com/api";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
// ── Cache advertiserów (name → UUID) — TTL 1h ────────────────────────────────
const ADVERTISER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 godzina
let advertiserNameCache = null;
let advertiserCacheTimestamp = 0;
function invalidateAdvertiserCache() {
    advertiserNameCache = null;
    advertiserCacheTimestamp = 0;
}
async function getAdvertiserCache(tokenOverride) {
    if (advertiserNameCache && Date.now() - advertiserCacheTimestamp < ADVERTISER_CACHE_TTL_MS) {
        return advertiserNameCache;
    }
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 89);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const created = (await apiPost("/custom-reports/previews", {
        dimensions: ["ADVERTISER_NAME", "ADVERTISER_UUID"],
        metrics: ["IMPRESSIONS"],
        start_date: fmt(start),
        end_date: fmt(end),
    }, tokenOverride));
    const preview = await pollUntilDone(created.uuid, tokenOverride);
    if (preview.status !== "SUCCEEDED" || !preview.result) {
        throw new Error("Nie udało się pobrać listy advertiserów (status: " + preview.status + ")");
    }
    const map = new Map();
    for (const row of preview.result) {
        const name = row["ADVERTISER_NAME"];
        const uuid = row["ADVERTISER_UUID"];
        if (name && uuid && typeof name === "string" && typeof uuid === "string") {
            map.set(name.toLowerCase(), { uuid, name });
        }
    }
    advertiserCacheTimestamp = Date.now();
    advertiserNameCache = map;
    return map;
}
async function resolveAdvertiserName(name, tokenOverride) {
    const cache = await getAdvertiserCache(tokenOverride);
    const query = name.toLowerCase().trim();
    if (cache.has(query))
        return cache.get(query).uuid;
    const matches = [];
    for (const [n, entry] of cache) {
        if (n.includes(query))
            matches.push({ displayName: entry.name, uuid: entry.uuid });
    }
    if (matches.length === 1)
        return matches[0].uuid;
    if (matches.length > 1) {
        const names = matches.map((m) => m.displayName).join(", ");
        throw new Error(`Niejednoznaczna nazwa advertisera "${name}" — pasuje kilka: ${names}. Podaj dokładniejszą nazwę.`);
    }
    const available = Array.from(cache.values()).map((e) => e.name).sort().join(", ");
    throw new Error(`Nie znaleziono advertisera "${name}". Dostępni advertiserzy: ${available}`);
}
// ── Skróty dat (period) ───────────────────────────────────────────────────────
const PERIOD_CODES = [
    "today", "yesterday",
    "last_7_days", "last_30_days",
    "this_month", "last_month",
    "this_quarter", "last_quarter",
    "this_year", "last_year",
];
function resolvePeriod(period) {
    const fmt = (d) => d.toISOString().slice(0, 10);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    switch (period) {
        case "today": {
            const s = fmt(today);
            return { start_date: s, end_date: s };
        }
        case "yesterday": {
            const d = new Date(today);
            d.setDate(d.getDate() - 1);
            const s = fmt(d);
            return { start_date: s, end_date: s };
        }
        case "last_7_days": {
            const end = new Date(today);
            end.setDate(end.getDate() - 1);
            const start = new Date(end);
            start.setDate(start.getDate() - 6);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
        case "last_30_days": {
            const end = new Date(today);
            end.setDate(end.getDate() - 1);
            const start = new Date(end);
            start.setDate(start.getDate() - 29);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
        case "this_month": {
            const start = new Date(today.getFullYear(), today.getMonth(), 1);
            const end = new Date(today);
            end.setDate(end.getDate() - 1);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
        case "last_month": {
            const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const end = new Date(today.getFullYear(), today.getMonth(), 0);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
        case "this_quarter": {
            const q = Math.floor(today.getMonth() / 3);
            const start = new Date(today.getFullYear(), q * 3, 1);
            const end = new Date(today);
            end.setDate(end.getDate() - 1);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
        case "last_quarter": {
            const q = Math.floor(today.getMonth() / 3);
            const prevQStart = q === 0 ? new Date(today.getFullYear() - 1, 9, 1) : new Date(today.getFullYear(), (q - 1) * 3, 1);
            const prevQEnd = new Date(today.getFullYear(), q * 3, 0);
            return { start_date: fmt(prevQStart), end_date: fmt(prevQEnd) };
        }
        case "this_year": {
            const start = new Date(today.getFullYear(), 0, 1);
            const end = new Date(today);
            end.setDate(end.getDate() - 1);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
        case "last_year": {
            const start = new Date(today.getFullYear() - 1, 0, 1);
            const end = new Date(today.getFullYear() - 1, 11, 31);
            return { start_date: fmt(start), end_date: fmt(end) };
        }
    }
}
function resolveDateRange(start_date, end_date, period) {
    if (period)
        return resolvePeriod(period);
    if (!start_date || !end_date) {
        throw new Error("Wymagane: podaj 'period' (np. 'last_month') lub oba parametry 'start_date' i 'end_date'.");
    }
    return { start_date, end_date };
}
const METRICS_CATALOG = [
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
const METRICS_BY_CODE = new Map(METRICS_CATALOG.map((m) => [m.code, m]));
const DIMENSIONS_CATALOG = [
    // TIME
    { code: "DATE", name: "Date", description: "Dzień (YYYY-MM-DD). Użyj do analizy dziennych trendów.", group: "TIME" },
    { code: "WEEK", name: "Week", description: "Tydzień (rok-numer). Użyj do analizy tygodniowej.", group: "TIME" },
    { code: "MONTH", name: "Month", description: "Miesiąc (YYYY-MM). Użyj do analizy miesięcznej.", group: "TIME" },
    { code: "YEAR", name: "Year", description: "Rok. Użyj do analizy rocznej.", group: "TIME" },
    // GEO
    { code: "CITY", name: "City", description: "Miasto użytkownika.", group: "GEO" },
    { code: "REGION", name: "Region", description: "Region/województwo użytkownika.", group: "GEO" },
    { code: "COUNTRY", name: "Country", description: "Kraj użytkownika (kod ISO).", group: "GEO" },
    { code: "POSTAL_CODE", name: "Postal Code", description: "Kod pocztowy użytkownika.", group: "GEO" },
    // DEVICE
    { code: "DEVICE_TYPE", name: "Device Type", description: "Typ urządzenia: desktop, mobile, tablet, ctv.", group: "DEVICE" },
    { code: "BROWSER", name: "Browser", description: "Przeglądarka użytkownika.", group: "DEVICE" },
    { code: "OPERATING_SYSTEM", name: "Operating System", description: "System operacyjny użytkownika.", group: "DEVICE" },
    { code: "ENVIRONMENT", name: "Environment", description: "Środowisko: web lub app.", group: "DEVICE" },
    // ADVERTISER
    { code: "ADVERTISER_NAME", name: "Advertiser Name", description: "Nazwa advertisera.", group: "ADVERTISER" },
    { code: "ADVERTISER_UUID", name: "Advertiser UUID", description: "UUID advertisera.", group: "ADVERTISER" },
    { code: "ADVERTISER_ID", name: "Advertiser ID", description: "Numeryczne ID advertisera.", group: "ADVERTISER" },
    { code: "ADVERTISER_HASH", name: "Advertiser Hash", description: "Hash advertisera.", group: "ADVERTISER" },
    { code: "ADVERTISER_COUNTRY", name: "Advertiser Country", description: "Kraj advertisera.", group: "ADVERTISER" },
    { code: "ADVERTISER_CURRENCY", name: "Advertiser Currency", description: "Waluta advertisera.", group: "ADVERTISER" },
    { code: "ADVERTISER_TIME_ZONE", name: "Advertiser Time Zone", description: "Strefa czasowa advertisera.", group: "ADVERTISER" },
    { code: "BUSINESS_GROUP", name: "Business Group", description: "Grupa biznesowa advertisera.", group: "ADVERTISER" },
    { code: "BRAND", name: "Brand", description: "Marka advertisera.", group: "ADVERTISER" },
    { code: "VERTICAL", name: "Vertical", description: "Branża advertisera (np. Automotive, Finance).", group: "ADVERTISER" },
    { code: "CLIENT_NAME", name: "Client Name", description: "Nazwa klienta/agencji.", group: "ADVERTISER" },
    { code: "PROFIT_CENTER", name: "Profit Center", description: "Centrum kosztów.", group: "ADVERTISER" },
    // CAMPAIGN
    { code: "CAMPAIGN_NAME", name: "Campaign Name", description: "Nazwa kampanii. Użyj z campaign_name do filtrowania po nazwie.", group: "CAMPAIGN" },
    { code: "CAMPAIGN_OBJECTIVE", name: "Campaign Objective", description: "Cel kampanii.", group: "CAMPAIGN" },
    { code: "CAMPAIGN_BUDGET", name: "Campaign Budget", description: "Budżet kampanii.", group: "CAMPAIGN" },
    { code: "CAMPAIGN_START_DATE", name: "Campaign Start Date", description: "Data startu kampanii.", group: "CAMPAIGN" },
    { code: "CAMPAIGN_END_DATE", name: "Campaign End Date", description: "Data końca kampanii.", group: "CAMPAIGN" },
    { code: "CAMPAIGN_STATUS", name: "Campaign Status", description: "Status kampanii: ACTIVE, PAUSED, ENDED.", group: "CAMPAIGN" },
    { code: "SUBCAMPAIGN_ID", name: "Subcampaign ID", description: "ID subkampanii.", group: "CAMPAIGN" },
    { code: "SUBCAMPAIGN_HASH", name: "Subcampaign Hash", description: "Hash subkampanii.", group: "CAMPAIGN" },
    { code: "SUBCAMPAIGN_CLIENTS_GROUP", name: "Subcampaign Clients Group", description: "Grupa klientów subkampanii.", group: "CAMPAIGN" },
    // LINE_ITEM
    { code: "LINE_ITEM_NAME", name: "Line Item Name", description: "Nazwa line item. Użyj z line_item_name do filtrowania po nazwie.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_TYPE", name: "Line Item Type", description: "Typ line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_BUDGET", name: "Line Item Budget", description: "Budżet line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_GROUP_NAME", name: "Line Item Group Name", description: "Nazwa grupy line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_START_DATE", name: "Line Item Start Date", description: "Data startu line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_END_DATE", name: "Line Item End Date", description: "Data końca line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_BIDDING_MODEL", name: "Line Item Bidding Model", description: "Model licytacji: CPM, CPC itp.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_STATUS", name: "Line Item Status", description: "Status line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_PRIMARY_GOAL_NAME", name: "Primary Goal", description: "Główny cel line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_SECONDARY_GOAL_NAME", name: "Secondary Goal", description: "Dodatkowy cel line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_TERTIARY_GOAL_NAME", name: "Tertiary Goal", description: "Trzeci cel line item.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_PRIMARY_GOAL_VALUE", name: "Primary Goal Value", description: "Wartość głównego celu.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_SECONDARY_GOAL_VALUE", name: "Secondary Goal Value", description: "Wartość dodatkowego celu.", group: "LINE_ITEM" },
    { code: "LINE_ITEM_TERTIARY_GOAL_VALUE", name: "Tertiary Goal Value", description: "Wartość trzeciego celu.", group: "LINE_ITEM" },
    // CREATIVE
    { code: "CREATIVE_NAME", name: "Creative Name", description: "Nazwa kreacji.", group: "CREATIVE" },
    { code: "CREATIVE_HASH", name: "Creative Hash", description: "Hash kreacji.", group: "CREATIVE" },
    { code: "CREATIVE_ID", name: "Creative ID", description: "ID kreacji.", group: "CREATIVE" },
    { code: "CREATIVE_TYPE", name: "Creative Type", description: "Typ kreacji: BANNER, VIDEO, AUDIO.", group: "CREATIVE" },
    { code: "CREATIVE_LINE", name: "Creative Line", description: "Linia kreacji.", group: "CREATIVE" },
    { code: "CREATIVE_SIZE", name: "Creative Size", description: "Rozmiar kreacji (np. 300x250).", group: "CREATIVE" },
    { code: "CREATIVE_DURATION", name: "Creative Duration", description: "Długość kreacji wideo/audio w sekundach.", group: "CREATIVE" },
    // INVENTORY
    { code: "DOMAIN", name: "Domain", description: "Pełna domena (np. www.onet.pl). Użyj do brand safety i analizy placementów.", group: "INVENTORY" },
    { code: "TOP_LEVEL_DOMAIN", name: "Top Level Domain", description: "Domena bez subdomeny (np. onet.pl). Agreguje wszystkie subdomeny razem.", group: "INVENTORY" },
    { code: "APP_NAME", name: "App Name", description: "Nazwa aplikacji mobilnej.", group: "INVENTORY" },
    { code: "APP_ID", name: "App ID", description: "ID/bundle aplikacji mobilnej.", group: "INVENTORY" },
    { code: "SUPPLY_SOURCE", name: "Supply Source", description: "Źródło supply (SSP/giełda, np. Google, Pubmatic).", group: "INVENTORY" },
];
// ── Dozwolone wartości (z OpenAPI enum) ──────────────────────────────────────
const DIMENSION_CODES = [
    "DATE", "WEEK", "MONTH", "YEAR",
    "CITY", "REGION", "COUNTRY", "POSTAL_CODE",
    "DEVICE_TYPE", "BROWSER", "OPERATING_SYSTEM", "ENVIRONMENT",
    "CLIENT_NAME", "PROFIT_CENTER",
    "ADVERTISER_NAME", "ADVERTISER_UUID", "ADVERTISER_ID", "ADVERTISER_HASH",
    "ADVERTISER_COUNTRY", "BUSINESS_GROUP", "BRAND", "ADVERTISER_CURRENCY",
    "VERTICAL", "ADVERTISER_TIME_ZONE",
    "CAMPAIGN_NAME", "CAMPAIGN_OBJECTIVE", "CAMPAIGN_BUDGET",
    "CAMPAIGN_START_DATE", "CAMPAIGN_END_DATE", "CAMPAIGN_STATUS",
    "LINE_ITEM_NAME", "LINE_ITEM_TYPE", "LINE_ITEM_BUDGET", "LINE_ITEM_GROUP_NAME",
    "LINE_ITEM_START_DATE", "LINE_ITEM_END_DATE", "LINE_ITEM_BIDDING_MODEL",
    "LINE_ITEM_PRIMARY_GOAL_NAME", "LINE_ITEM_SECONDARY_GOAL_NAME", "LINE_ITEM_TERTIARY_GOAL_NAME",
    "LINE_ITEM_PRIMARY_GOAL_VALUE", "LINE_ITEM_SECONDARY_GOAL_VALUE", "LINE_ITEM_TERTIARY_GOAL_VALUE",
    "SUBCAMPAIGN_ID", "SUBCAMPAIGN_HASH", "SUBCAMPAIGN_CLIENTS_GROUP", "LINE_ITEM_STATUS",
    "CREATIVE_NAME", "CREATIVE_HASH", "CREATIVE_ID", "CREATIVE_TYPE",
    "CREATIVE_LINE", "CREATIVE_SIZE", "CREATIVE_DURATION",
    "DOMAIN", "TOP_LEVEL_DOMAIN", "APP_NAME", "APP_ID", "SUPPLY_SOURCE",
];
const METRIC_CODES = [
    "IMPRESSIONS", "IMPRESSIONS_SHARE", "VIEWABLE_IMPRESSIONS", "MEASURABLE_IMPRESSIONS",
    "MEASURABILITY", "VIEWABILITY", "CLICKS", "CLICKS_SHARE", "CLICK_THROUGH_RATE",
    "REACH", "FREQUENCY",
    "AUDIO_COMPLETE_LISTENS", "AUDIO_COMPLETION_RATE", "AUDIO_STARTS",
    "AUDIO_PLAYS_25", "AUDIO_PLAYS_50", "AUDIO_PLAYS_75", "AUDIO_PLAYS_100",
    "AUDIO_PAUSES", "AUDIO_RESUMES", "AUDIO_MUTES", "AUDIO_UNMUTES", "AUDIO_SKIPS",
    "VIDEO_COMPLETE_VIEWS", "VIDEO_COMPLETION_RATE", "VIDEO_STARTS",
    "VIDEO_PLAYS_25", "VIDEO_PLAYS_50", "VIDEO_PLAYS_75", "VIDEO_PLAYS_100",
    "VIDEO_PAUSES", "VIDEO_RESUMES", "VIDEO_MUTES", "VIDEO_UNMUTES", "VIDEO_SKIPS",
    "VIDEO_EXPANDS", "VIDEO_ERRORS",
    "TOTAL_CONVERSIONS", "LANDING_PAGE_VIEWS", "LANDING_RATE", "CONVERSION_RATE",
    "VIEW_THROUGH_CONVERSION_RATE", "CLICK_CONVERSION_RATE",
    "POST_VIEW_CONVERSIONS", "POST_CLICK_CONVERSIONS",
    "CONVERSION_VALUE_USD", "CONVERSION_VALUE_ADVERTISER_CURRENCY", "ROI", "ROAS",
    "TOTAL_SPEND_USD", "TOTAL_SPEND_ADVERTISER_CURRENCY",
    "ECPM_USD", "VCPM_USD", "ECPC_USD", "ECPA_USD", "ECPA_PV_USD", "ECPA_PC_USD",
    "ECPCV_USD", "ECPLPV_USD", "ECPCL_USD",
    "ECPM_ADVERTISER_CURRENCY", "VCPM_ADVERTISER_CURRENCY", "ECPC_ADVERTISER_CURRENCY",
    "ECPA_ADVERTISER_CURRENCY", "ECPA_PV_ADVERTISER_CURRENCY", "ECPA_PC_ADVERTISER_CURRENCY",
    "ECPCV_ADVERTISER_CURRENCY", "ECPLPV_ADVERTISER_CURRENCY", "ECPCL_ADVERTISER_CURRENCY",
];
const FILTER_FIELDS = ["ADVERTISER_UUID", "CLIENT_UUID"];
// ── Schematy Zod (wejście narzędzi) ──────────────────────────────────────────
const FilterSchema = z.object({
    field: z.enum(FILTER_FIELDS).describe("Pole filtrowania: ADVERTISER_UUID lub CLIENT_UUID"),
    value: z.array(z.string().uuid()).min(1).describe("Lista UUID encji"),
});
const ReportRequestSchema = {
    dimensions: z
        .array(z.enum(DIMENSION_CODES))
        .min(1)
        .describe("Lista wymiarów raportu (min. 1). Użyj list_dimensions żeby poznać dostępne opcje."),
    metrics: z
        .array(z.enum(METRIC_CODES))
        .optional()
        .describe("Lista metryk raportu (opcjonalna). Użyj list_metrics żeby poznać dostępne opcje."),
    period: z
        .enum(PERIOD_CODES)
        .optional()
        .describe("Skrót okresu — alternatywa dla start_date/end_date. " +
        "Wartości: today, yesterday, last_7_days, last_30_days, this_month, last_month, " +
        "this_quarter, last_quarter, this_year, last_year. " +
        "Podaj period LUB (start_date + end_date)."),
    start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD")
        .optional()
        .describe("Data początku okresu (YYYY-MM-DD, max 185 dni wstecz). Wymagane jeśli nie podano 'period'."),
    end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD")
        .optional()
        .describe("Data końca okresu (YYYY-MM-DD, >= start_date). Wymagane jeśli nie podano 'period'."),
    filters: z
        .array(FilterSchema)
        .optional()
        .describe("Opcjonalne filtry (ADVERTISER_UUID / CLIENT_UUID)"),
    advertiser_name: z
        .string()
        .optional()
        .describe("Nazwa advertisera (lub jej fragment) — MCP automatycznie zamieni ją na ADVERTISER_UUID i doda do filters. " +
        "Użyj list_advertisers żeby zobaczyć dostępne nazwy. Przy niejednoznacznym dopasowaniu zwróci błąd z listą kandydatów."),
    adlook_token: z
        .string()
        .min(1)
        .optional()
        .describe("Opcjonalny token Bearer do Adlook API. Jeśli nie podasz, użyty będzie ADLOOK_TOKEN z env."),
};
// ── Schemat filtrów po nazwie (tylko dla narzędzi z post-processingiem) ───────
const NameFilterSchema = {
    campaign_name: z
        .string()
        .optional()
        .describe("Filtruj wyniki po nazwie kampanii (fragment, case-insensitive regexp). " +
        "Wymaga CAMPAIGN_NAME w dimensions. Automatycznie dodaje regexp do result_filters."),
    line_item_name: z
        .string()
        .optional()
        .describe("Filtruj wyniki po nazwie line item (fragment, case-insensitive regexp). " +
        "Wymaga LINE_ITEM_NAME w dimensions. Automatycznie dodaje regexp do result_filters."),
};
const filterLeafSchema = z.object({
    column: z.string().describe("Nazwa kolumny"),
    regexp: z.string().describe("Wyrażenie regularne JS"),
    flags: z
        .string()
        .optional()
        .describe("Flagi RegExp, domyślnie 'i'; flaga 'g' jest ignorowana"),
});
const filterRangeSchema = z
    .object({
    column: z.string().describe("Nazwa kolumny numerycznej"),
    gt: z.number().optional().describe("Strictly greater than (>)"),
    gte: z.number().optional().describe("Greater than or equal (>=)"),
    lt: z.number().optional().describe("Strictly less than (<)"),
    lte: z.number().optional().describe("Less than or equal (<=)"),
})
    .refine((v) => v.gt !== undefined ||
    v.gte !== undefined ||
    v.lt !== undefined ||
    v.lte !== undefined, { message: "FilterRange wymaga przynajmniej jednej granicy: gt, gte, lt lub lte" });
const conditionSchema = z.lazy(() => z.union([
    filterLeafSchema,
    filterRangeSchema,
    z.object({ and: z.array(conditionSchema).min(1) }),
    z.object({ or: z.array(conditionSchema).min(1) }),
]));
const PostProcessingSchema = {
    result_filters: z
        .optional(conditionSchema)
        .describe("Drzewo warunków filtrowania wyników po stronie MCP: REGEXP (dopasowanie tekstowe), " +
        "zakres numeryczny (gt/gte/lt/lte), zagnieżdżone AND/OR. " +
        'Odróżnia się od "filters" (filtr UUID po stronie API).'),
    sort: z
        .optional(z.object({
        column: z.string().describe("Nazwa kolumny do sortowania"),
        direction: z.enum(["ASC", "DESC"]).describe("Kierunek sortowania"),
    }))
        .describe("Sortowanie wyników po dowolnej kolumnie (po filtrowaniu, przed limitowaniem)"),
    top: z
        .optional(z.number().int().min(1))
        .describe("Ogranicz wyniki do N pierwszych wierszy (po filtrowaniu i sortowaniu)"),
    columns: z
        .optional(z.array(z.string()).min(1))
        .describe("Podzbiór kolumn do zwrócenia (projekcja; nieistniejące kolumny pomijane)"),
    group_by: z
        .optional(z.array(z.string()).min(1))
        .describe("Kolumny grupujące — musi być użyte razem z aggregate"),
    aggregate: z
        .optional(z
        .array(z.object({
        column: z.string().describe("Kolumna do agregacji"),
        fn: z
            .enum(["SUM", "AVG", "MIN", "MAX", "COUNT"])
            .describe("Funkcja agregująca"),
        as: z
            .string()
            .optional()
            .describe("Opcjonalna nazwa wynikowej kolumny (domyślnie: FN_COLUMN)"),
    }))
        .min(1))
        .describe("Funkcje agregujące — musi być użyte razem z group_by"),
    summarize: z
        .optional(z.literal(true))
        .describe("Zamiast danych zwróć statystyki opisowe (min/max/sum/avg dla numerycznych, " +
        "distinct_count/sample_values dla tekstowych). Wyklucza: aggregate, distinct."),
    distinct: z
        .optional(z.string())
        .describe("Zwróć posortowaną listę unikalnych wartości dla wskazanej kolumny. " +
        "Wyklucza: aggregate, summarize, sort, top, columns."),
    output_format: z
        .optional(z.enum(["json", "columnar", "csv"]))
        .describe('Format serializacji wyników: "columnar" (domyślny, nagłówki raz + tablica tablic — ~50% mniej tokenów), ' +
        '"json" (tablica obiektów — czytelniejszy dla małych zbiorów), ' +
        '"csv" (string CSV). Nie dotyczy trybów summarize/distinct.'),
};
// ── Pomocniki HTTP ────────────────────────────────────────────────────────────
function bearerJsonHeaders(accessToken) {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
    };
}
/** Jedno ponowienie przy 401, gdy używany jest token z env + skonfigurowany OAuth refresh. */
async function apiPost(path, body, tokenOverride) {
    const tryPost = async (isRetry) => {
        const token = await resolveAccessToken(tokenOverride);
        const res = await fetch(`${BASE_URL}${path}`, {
            method: "POST",
            headers: bearerJsonHeaders(token),
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (res.status === 401 &&
            !isRetry &&
            !tokenOverride?.trim() &&
            isOAuthRefreshConfigured()) {
            invalidateCachedAccessToken();
            return tryPost(true);
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
        }
        return data;
    };
    return tryPost(false);
}
async function apiGet(path, tokenOverride) {
    const tryGet = async (isRetry) => {
        const token = await resolveAccessToken(tokenOverride);
        const res = await fetch(`${BASE_URL}${path}`, {
            method: "GET",
            headers: bearerJsonHeaders(token),
        });
        const data = await res.json();
        if (res.status === 401 &&
            !isRetry &&
            !tokenOverride?.trim() &&
            isOAuthRefreshConfigured()) {
            invalidateCachedAccessToken();
            return tryGet(true);
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
        }
        return data;
    };
    return tryGet(false);
}
async function pollUntilDone(uuid, tokenOverride, intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_POLL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const preview = (await apiGet(`/custom-reports/previews/${uuid}`, tokenOverride));
        if (preview.status === "SUCCEEDED" || preview.status === "FAILED") {
            return preview;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout: zadanie ${uuid} nie zakończyło się w ciągu ${timeoutMs / 1000}s`);
}
// ── Post-processing ────────────────────────────────────────────────────────────
/** Parsuje wartości numeryczne i procentowe ("63.80%" → 63.80). */
function parseNumeric(v) {
    if (v == null)
        return NaN;
    if (typeof v === "number")
        return v;
    const s = String(v).trim();
    return Number(s.endsWith("%") ? s.slice(0, -1) : s);
}
function detectColumnType(rows, column) {
    const firstNonNull = rows.find((row) => row[column] != null);
    if (!firstNonNull)
        return "text";
    return !isNaN(parseNumeric(firstNonNull[column])) ? "numeric" : "text";
}
function evaluateCondition(row, condition) {
    if ("and" in condition) {
        return condition.and.every((c) => evaluateCondition(row, c));
    }
    if ("or" in condition) {
        return condition.or.some((c) => evaluateCondition(row, c));
    }
    const col = condition.column;
    if ("regexp" in condition) {
        const leaf = condition;
        const val = row[col] ?? "";
        const str = String(val);
        const flags = (leaf.flags ?? "i").replace(/g/gi, "");
        // throws on invalid regexp — caught by applyFiltering
        const re = new RegExp(leaf.regexp, flags);
        return re.test(str);
    }
    // FilterRange
    const range = condition;
    const rawVal = row[col];
    if (rawVal == null)
        return false;
    const num = parseNumeric(rawVal);
    if (isNaN(num))
        return false;
    if (range.gt !== undefined && !(num > range.gt))
        return false;
    if (range.gte !== undefined && !(num >= range.gte))
        return false;
    if (range.lt !== undefined && !(num < range.lt))
        return false;
    if (range.lte !== undefined && !(num <= range.lte))
        return false;
    return true;
}
function applyFiltering(rows, condition) {
    try {
        return { rows: rows.filter((row) => evaluateCondition(row, condition)) };
    }
    catch (e) {
        return { rows: [], error: e.message };
    }
}
function applyAggregation(rows, group_by, aggregate) {
    const groupMap = new Map();
    const groupKeys = new Map();
    for (const row of rows) {
        const vals = group_by.map((col) => row[col] ?? null);
        const key = JSON.stringify(vals);
        if (!groupMap.has(key)) {
            groupMap.set(key, []);
            const keyRow = {};
            for (let i = 0; i < group_by.length; i++) {
                keyRow[group_by[i]] = vals[i];
            }
            groupKeys.set(key, keyRow);
        }
        groupMap.get(key).push(row);
    }
    const result = [];
    for (const [key, groupRows] of groupMap) {
        const outRow = { ...groupKeys.get(key) };
        for (const agg of aggregate) {
            const outCol = agg.as ?? `${agg.fn}_${agg.column}`;
            if (agg.fn === "COUNT") {
                outRow[outCol] = groupRows.length;
                continue;
            }
            const nonNullVals = groupRows.map((r) => r[agg.column]).filter((v) => v != null);
            if (agg.fn === "SUM" || agg.fn === "AVG") {
                const nums = nonNullVals.map(parseNumeric).filter((v) => !isNaN(v));
                if (nums.length === 0) {
                    outRow[outCol] = null;
                }
                else if (agg.fn === "SUM") {
                    outRow[outCol] = nums.reduce((a, b) => a + b, 0);
                }
                else {
                    outRow[outCol] = nums.reduce((a, b) => a + b, 0) / nums.length;
                }
                continue;
            }
            // MIN / MAX
            if (nonNullVals.length === 0) {
                outRow[outCol] = null;
                continue;
            }
            const firstNonNull = nonNullVals[0];
            const isNumeric = !isNaN(parseNumeric(firstNonNull));
            if (isNumeric) {
                const nums = nonNullVals.map(parseNumeric).filter((v) => !isNaN(v));
                outRow[outCol] = agg.fn === "MIN" ? Math.min(...nums) : Math.max(...nums);
            }
            else {
                const strs = nonNullVals.map((v) => String(v));
                outRow[outCol] =
                    agg.fn === "MIN"
                        ? strs.reduce((a, b) => (a.localeCompare(b) <= 0 ? a : b))
                        : strs.reduce((a, b) => (a.localeCompare(b) >= 0 ? a : b));
            }
        }
        result.push(outRow);
    }
    return result;
}
function applySorting(rows, sort) {
    if (rows.length === 0)
        return { rows };
    const colExists = rows.some((row) => sort.column in row);
    if (!colExists) {
        return {
            rows,
            error: `Kolumna '${sort.column}' nie istnieje w wynikach raportu.`,
        };
    }
    const type = detectColumnType(rows, sort.column);
    const sorted = [...rows].sort((a, b) => {
        const va = a[sort.column];
        const vb = b[sort.column];
        if (va == null && vb == null)
            return 0;
        if (va == null)
            return 1;
        if (vb == null)
            return -1;
        const cmp = type === "numeric"
            ? parseNumeric(va) - parseNumeric(vb)
            : String(va).localeCompare(String(vb), undefined, { sensitivity: "base" });
        return sort.direction === "DESC" ? -cmp : cmp;
    });
    return { rows: sorted };
}
function applyProjection(rows, columns) {
    if (rows.length === 0)
        return { rows };
    const existing = columns.filter((col) => rows.some((row) => col in row));
    if (existing.length === 0) {
        return { rows, error: "Żadna z podanych kolumn nie istnieje w wynikach raportu." };
    }
    return {
        rows: rows.map((row) => {
            const out = {};
            for (const col of existing)
                out[col] = row[col];
            return out;
        }),
    };
}
function applyOutputFormat(rows, format, columnOrder) {
    if (format === "json")
        return rows;
    const cols = columnOrder ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
    if (format === "columnar") {
        return {
            columns: cols,
            rows: rows.map((row) => cols.map((col) => row[col] ?? null)),
        };
    }
    // CSV
    const lines = [cols.join(",")];
    for (const row of rows) {
        const vals = cols.map((col) => {
            const v = row[col];
            if (v == null)
                return "";
            const s = String(v);
            if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        });
        lines.push(vals.join(","));
    }
    return lines.join("\n") + "\n";
}
function buildSummary(rows) {
    if (rows.length === 0)
        return [];
    const columns = Object.keys(rows[0]);
    const summary = [];
    for (const col of columns) {
        const values = rows.map((r) => r[col]);
        const nonNull = values.filter((v) => v != null);
        const null_count = values.length - nonNull.length;
        const type = nonNull.length > 0 && !isNaN(parseNumeric(nonNull[0])) ? "numeric" : "text";
        if (type === "numeric") {
            const nums = nonNull.map(parseNumeric).filter((v) => !isNaN(v));
            const sum = nums.reduce((a, b) => a + b, 0);
            summary.push({
                column: col,
                type: "numeric",
                count: nonNull.length,
                null_count,
                min: nums.length ? Math.min(...nums) : undefined,
                max: nums.length ? Math.max(...nums) : undefined,
                sum: nums.length ? sum : undefined,
                avg: nums.length ? sum / nums.length : undefined,
            });
        }
        else {
            const strs = nonNull.map((v) => String(v));
            const distinct = new Set(strs);
            const dc = distinct.size;
            summary.push({
                column: col,
                type: "text",
                count: nonNull.length,
                null_count,
                distinct_count: dc > 1000 ? "+" : dc,
                sample_values: Array.from(distinct).slice(0, 5),
            });
        }
    }
    return summary;
}
function buildDistinct(rows, column) {
    const seen = new Map();
    let hasNull = false;
    for (const row of rows) {
        const val = row[column];
        if (val == null) {
            hasNull = true;
        }
        else {
            const k = `${typeof val}:${String(val)}`;
            if (!seen.has(k))
                seen.set(k, val);
        }
    }
    const values = Array.from(seen.values());
    const isNumeric = values.length > 0 && !isNaN(Number(values[0]));
    values.sort((a, b) => isNumeric
        ? Number(a) - Number(b)
        : String(a).localeCompare(String(b)));
    if (hasNull)
        values.push(null);
    return { values, distinct_count: values.length };
}
function validatePostProcessing(args) {
    const hasGroupBy = args.group_by != null;
    const hasAggregate = args.aggregate != null;
    const hasSummarize = args.summarize === true;
    const hasDistinct = args.distinct != null;
    if (hasGroupBy !== hasAggregate) {
        return "Parametry 'group_by' i 'aggregate' muszą być podane razem (oba lub żadne).";
    }
    if (hasSummarize && (hasGroupBy || hasDistinct)) {
        return "Parametr 'summarize' nie może być użyty z 'group_by'/'aggregate' ani 'distinct'.";
    }
    if (hasDistinct) {
        if (hasGroupBy)
            return "Parametr 'distinct' nie może być użyty z 'group_by'/'aggregate'.";
        if (args.sort)
            return "Parametr 'distinct' nie może być użyty z 'sort'.";
        if (args.top)
            return "Parametr 'distinct' nie może być użyty z 'top'.";
        if (args.columns)
            return "Parametr 'distinct' nie może być użyty z 'columns'.";
    }
    return null;
}
function runPostProcessing(preview, args) {
    if (preview.status !== "SUCCEEDED" || !preview.result) {
        return { payload: preview };
    }
    const total_rows = preview.total_rows;
    let rows = preview.result;
    let filtered_rows;
    const processing = {
        filtered: false,
        aggregated: false,
        sorted: false,
        limited: false,
        projected: false,
        output_format: args.output_format ?? "columnar",
    };
    // 1. Filter
    if (args.result_filters) {
        const r = applyFiltering(rows, args.result_filters);
        if (r.error)
            return { isError: true, payload: { error: r.error } };
        rows = r.rows;
        filtered_rows = rows.length;
        processing.filtered = true;
    }
    // Summarize mode
    if (args.summarize) {
        const summary = buildSummary(rows);
        const resp = { status: "SUCCEEDED", total_rows, summary };
        if (filtered_rows !== undefined)
            resp.filtered_rows = filtered_rows;
        return { payload: resp };
    }
    // Distinct mode
    if (args.distinct) {
        const { values, distinct_count } = buildDistinct(rows, args.distinct);
        const resp = {
            status: "SUCCEEDED",
            total_rows,
            column: args.distinct,
            values,
            distinct_count,
        };
        if (filtered_rows !== undefined)
            resp.filtered_rows = filtered_rows;
        return { payload: resp };
    }
    // 2. Aggregate
    let aggregated_rows;
    if (args.group_by && args.aggregate) {
        rows = applyAggregation(rows, args.group_by, args.aggregate);
        aggregated_rows = rows.length;
        processing.aggregated = true;
    }
    // 3. Sort
    if (args.sort) {
        const r = applySorting(rows, args.sort);
        if (r.error)
            return { isError: true, payload: { error: r.error } };
        rows = r.rows;
        processing.sorted = true;
    }
    // 4. Limit
    if (args.top !== undefined) {
        rows = rows.slice(0, args.top);
        processing.limited = true;
    }
    // 5. Project columns
    let projectedColumns;
    if (args.columns) {
        const r = applyProjection(rows, args.columns);
        if (r.error)
            return { isError: true, payload: { error: r.error } };
        rows = r.rows;
        processing.projected = true;
        projectedColumns = args.columns.filter((col) => rows.some((row) => col in row));
    }
    // 6. Serialize
    const formatted = applyOutputFormat(rows, processing.output_format, projectedColumns);
    const resp = {
        status: "SUCCEEDED",
        total_rows,
        result: formatted,
        returned_rows: rows.length,
        processing_applied: processing,
    };
    if (filtered_rows !== undefined)
        resp.filtered_rows = filtered_rows;
    if (aggregated_rows !== undefined)
        resp.aggregated_rows = aggregated_rows;
    return { payload: resp };
}
// ── MCP Server ────────────────────────────────────────────────────────────────
function createServer() {
    const server = new McpServer({
        name: "adlook-custom-reports",
        version: "1.0.0",
    });
    // ── Narzędzie: set_adlook_auth (sesja) ───────────────────────────────────────
    server.tool("set_adlook_auth", "Na początku sesji: zapisuje tokeny skopiowane z przeglądarki (tylko w pamięci tego procesu MCP). " +
        "access_token — JWT z nagłówka Authorization (same znaki po 'Bearer ') albo z Application → Local Storage. " +
        "refresh_token — z odpowiedzi żądania logowania (Network) lub innego źródła; bez niego serwer nie może sam odświeżać access tokenu. " +
        "Po ustawieniu pozostałe narzędzia używają tych tokenów zamiast ADLOOK_TOKEN z env.", {
        access_token: z
            .string()
            .min(1)
            .describe("Access token (JWT) z przeglądarki"),
        refresh_token: z
            .string()
            .optional()
            .describe("Refresh token — wymagany do automatycznego odświeżania; bez tego działa tylko do wygaśnięcia access tokenu"),
    }, async ({ access_token, refresh_token }) => {
        try {
            setSessionAuth(access_token, refresh_token);
            invalidateAdvertiserCache();
            const canRefresh = isOAuthRefreshConfigured();
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            ok: true,
                            auto_refresh: canRefresh,
                            message: canRefresh
                                ? "Tokeny zapisane. MCP będzie odświeżać access token przez POST .../auth/token/refresh."
                                : "Zapisano tylko access token. Dodaj refresh_token (albo ADLOOK_REFRESH_TOKEN w env), żeby działało automatyczne odświeżanie.",
                        }, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Błąd: ${err.message}` }],
                isError: true,
            };
        }
    });
    // ── Narzędzie 1: create_report_preview ───────────────────────────────────────
    server.tool("create_report_preview", "Niskopoziomowe narzędzie: tworzy zadanie raportu i zwraca UUID (bez czekania na wynik). " +
        "Używaj TYLKO gdy potrzebujesz UUID do własnego pollingu. " +
        "W pozostałych przypadkach użyj run_report_preview — robi to samo w jednym wywołaniu.", ReportRequestSchema, async (args) => {
        try {
            const { adlook_token, advertiser_name, period, start_date, end_date, ...reportArgs } = args;
            const dates = resolveDateRange(start_date, end_date, period);
            Object.assign(reportArgs, dates);
            if (advertiser_name) {
                const uuid = await resolveAdvertiserName(advertiser_name, adlook_token);
                reportArgs["filters"] = [...(reportArgs["filters"] ?? []), { field: "ADVERTISER_UUID", value: [uuid] }];
            }
            const result = await apiPost("/custom-reports/previews", reportArgs, adlook_token);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Błąd: ${err.message}` }],
                isError: true,
            };
        }
    });
    // ── Narzędzie 2: get_report_preview ──────────────────────────────────────────
    server.tool("get_report_preview", "Pobiera aktualny stan podglądu raportu (GET /api/custom-reports/previews/{uuid}). " +
        "Status PENDING oznacza, że zadanie jest jeszcze przetwarzane. " +
        "Jeśli status to SUCCEEDED, można zastosować post-processing: filtrowanie, agregację, sortowanie, limitowanie, projekcję kolumn i zmianę formatu.", {
        uuid: z
            .string()
            .uuid()
            .describe("UUID podglądu zwrócony przez create_report_preview"),
        adlook_token: z
            .string()
            .min(1)
            .optional()
            .describe("Opcjonalny token Bearer do Adlook API. Jeśli nie podasz, użyty będzie ADLOOK_TOKEN z env."),
        ...NameFilterSchema,
        ...PostProcessingSchema,
    }, async ({ uuid, adlook_token, campaign_name, line_item_name, ...ppArgs }) => {
        // Merge campaign/line_item name filters into result_filters
        const nameConditions = [];
        if (campaign_name)
            nameConditions.push({ column: "CAMPAIGN_NAME", regexp: campaign_name });
        if (line_item_name)
            nameConditions.push({ column: "LINE_ITEM_NAME", regexp: line_item_name });
        if (nameConditions.length > 0) {
            const combined = nameConditions.length === 1 ? nameConditions[0] : { and: nameConditions };
            ppArgs.result_filters = ppArgs.result_filters
                ? { and: [ppArgs.result_filters, combined] }
                : combined;
        }
        try {
            const validationError = validatePostProcessing(ppArgs);
            if (validationError) {
                return {
                    content: [{ type: "text", text: validationError }],
                    isError: true,
                };
            }
            const raw = await apiGet(`/custom-reports/previews/${uuid}`, adlook_token);
            const preview = raw;
            const { isError, payload } = runPostProcessing(preview, ppArgs);
            return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                ...(isError ? { isError: true } : {}),
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Błąd: ${err.message}` }],
                isError: true,
            };
        }
    });
    // ── Narzędzie 3: run_report_preview ──────────────────────────────────────────
    server.tool("run_report_preview", "Tworzy zadanie raportu (POST), czeka na zakończenie (polling) i zwraca wynik z pełnym post-processingiem. " +
        "UŻYJ TEGO narzędzia jako domyślnego do pobierania danych — łączy create + poll + przetwarzanie w jednym wywołaniu.\n\n" +
        "Post-processing: result_filters (filtrowanie), sort (sortowanie), top (limit N wierszy), " +
        "group_by+aggregate (agregacja), columns (projekcja), summarize (statystyki opisowe), " +
        "distinct (unikalne wartości), output_format (format wyjścia, domyślnie columnar).\n\n" +
        "Wskazówka: przy nieznanych danych użyj summarize:true najpierw, żeby ocenić skalę przed pobraniem pełnych wyników.\n\n" +
        "Przykłady:\n" +
        "• Top 10 domen wg impresji: dimensions:[DOMAIN], metrics:[IMPRESSIONS], sort:{column:IMPRESSIONS,direction:DESC}, top:10\n" +
        "• Wydatki per kampania w ub. miesiącu: dimensions:[CAMPAIGN_NAME], metrics:[TOTAL_SPEND_USD], period:last_month\n" +
        "• Viewability per advertiser: dimensions:[ADVERTISER_NAME], metrics:[VIEWABILITY,IMPRESSIONS], sort:{column:IMPRESSIONS,direction:DESC}\n" +
        "• CTR po device type: dimensions:[DEVICE_TYPE], metrics:[CLICKS,IMPRESSIONS,CLICK_THROUGH_RATE]\n" +
        "• Kampanie danego advertisera: advertiser_name:'Play', dimensions:[CAMPAIGN_NAME], metrics:[IMPRESSIONS], period:last_month", { ...ReportRequestSchema, ...NameFilterSchema, ...PostProcessingSchema }, async (reportArgs) => {
        try {
            const { adlook_token, advertiser_name, campaign_name, line_item_name, period, start_date, end_date, result_filters, sort, top, columns, group_by, aggregate, summarize, distinct, output_format, ...createArgs } = reportArgs;
            let ppResultFilters = result_filters;
            // Resolve name filters → result_filters
            const nameConditions = [];
            if (campaign_name)
                nameConditions.push({ column: "CAMPAIGN_NAME", regexp: campaign_name });
            if (line_item_name)
                nameConditions.push({ column: "LINE_ITEM_NAME", regexp: line_item_name });
            if (nameConditions.length > 0) {
                const combined = nameConditions.length === 1 ? nameConditions[0] : { and: nameConditions };
                ppResultFilters = ppResultFilters ? { and: [ppResultFilters, combined] } : combined;
            }
            const ppArgs = { result_filters: ppResultFilters, sort, top, columns, group_by, aggregate, summarize, distinct, output_format };
            const dates = resolveDateRange(start_date, end_date, period);
            Object.assign(createArgs, dates);
            if (advertiser_name) {
                const uuid = await resolveAdvertiserName(advertiser_name, adlook_token);
                createArgs["filters"] = [...(createArgs["filters"] ?? []), { field: "ADVERTISER_UUID", value: [uuid] }];
            }
            const validationError = validatePostProcessing(ppArgs);
            if (validationError) {
                return {
                    content: [{ type: "text", text: validationError }],
                    isError: true,
                };
            }
            const created = (await apiPost("/custom-reports/previews", createArgs, adlook_token));
            const preview = await pollUntilDone(created.uuid, adlook_token);
            const { isError, payload } = runPostProcessing(preview, ppArgs);
            return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                ...(isError ? { isError: true } : {}),
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Błąd: ${err.message}` }],
                isError: true,
            };
        }
    });
    // ── Narzędzie 4: list_metrics ────────────────────────────────────────────────
    server.tool("list_metrics", "Zwraca pełną listę dostępnych metryk z nazwami, opisami i grupami. " +
        "Używaj tego narzędzia, gdy chcesz dowiedzieć się co oznacza dana metryka, " +
        "lub gdy potrzebujesz wybrać odpowiednie metryki do raportu. " +
        "Możesz filtrować po grupie: AUDIO, VIDEO, PERFORMANCE, CONVERSIONS, COST, PAGE_VISITS, UNIQUES.", {
        group: z
            .enum(["AUDIO", "VIDEO", "PERFORMANCE", "CONVERSIONS", "COST", "PAGE_VISITS", "UNIQUES"])
            .optional()
            .describe("Opcjonalne filtrowanie po grupie metryk"),
        search: z
            .string()
            .optional()
            .describe("Opcjonalne wyszukiwanie po nazwie lub opisie metryki (case-insensitive)"),
    }, async ({ group, search }) => {
        let results = METRICS_CATALOG;
        if (group) {
            results = results.filter((m) => m.group === group);
        }
        if (search) {
            const q = search.toLowerCase();
            results = results.filter((m) => m.name.toLowerCase().includes(q) ||
                m.description.toLowerCase().includes(q) ||
                m.code.toLowerCase().includes(q));
        }
        const grouped = results.reduce((acc, m) => {
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
                    text: JSON.stringify({ total: results.length, groups: output }, null, 2),
                },
            ],
        };
    });
    // ── Narzędzie: list_dimensions ────────────────────────────────────────────────
    server.tool("list_dimensions", "Zwraca listę dostępnych wymiarów raportu z opisami i grupami. " +
        "Używaj gdy nie wiesz jakiego wymiaru użyć do konkretnego pytania analitycznego. " +
        "Grupy: TIME, GEO, DEVICE, ADVERTISER, CAMPAIGN, LINE_ITEM, CREATIVE, INVENTORY.", {
        group: z
            .enum(["TIME", "GEO", "DEVICE", "ADVERTISER", "CAMPAIGN", "LINE_ITEM", "CREATIVE", "INVENTORY"])
            .optional()
            .describe("Opcjonalne filtrowanie po grupie wymiarów"),
        search: z
            .string()
            .optional()
            .describe("Opcjonalne wyszukiwanie po nazwie, kodzie lub opisie (case-insensitive)"),
    }, async ({ group, search }) => {
        let results = DIMENSIONS_CATALOG;
        if (group)
            results = results.filter((d) => d.group === group);
        if (search) {
            const q = search.toLowerCase();
            results = results.filter((d) => d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
        }
        const grouped = results.reduce((acc, d) => {
            (acc[d.group] ??= []).push(d);
            return acc;
        }, {});
        const output = Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([grp, dims]) => ({ group: grp, dimensions: dims.map((d) => ({ code: d.code, name: d.name, description: d.description })) }));
        return { content: [{ type: "text", text: JSON.stringify({ total: results.length, groups: output }, null, 2) }] };
    });
    // ── Narzędzie: list_advertisers ───────────────────────────────────────────────
    server.tool("list_advertisers", "Zwraca listę dostępnych advertiserów (nazwa + UUID). " +
        "Używaj przed run_report_preview, żeby znaleźć dokładną nazwę do parametru advertiser_name. " +
        "Wyniki są cache'owane przez 1 godzinę (budowane z danych z ostatnich 90 dni).", {
        search: z.string().optional().describe("Opcjonalne filtrowanie po fragmencie nazwy (case-insensitive)"),
        adlook_token: z.string().min(1).optional().describe("Opcjonalny token Bearer do Adlook API"),
    }, async ({ search, adlook_token }) => {
        try {
            const cache = await getAdvertiserCache(adlook_token);
            let entries = Array.from(cache.values())
                .sort((a, b) => a.name.localeCompare(b.name));
            if (search) {
                const q = search.toLowerCase();
                entries = entries.filter((e) => e.name.includes(q));
            }
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            total: entries.length,
                            advertisers: entries,
                            note: "Lista pochodzi z ostatnich 90 dni aktywności. Cache odświeżany co 1h.",
                        }, null, 2),
                    }],
            };
        }
        catch (err) {
            return { content: [{ type: "text", text: `Błąd: ${err.message}` }], isError: true };
        }
    });
    // ── Narzędzie: check_auth ─────────────────────────────────────────────────────
    server.tool("check_auth", "Sprawdza status autoryzacji — czy token jest ustawiony i kiedy wygasa. " +
        "Nie wykonuje zapytania do API, tylko dekoduje JWT lokalnie. " +
        "Wywołaj na początku sesji lub gdy inne narzędzia zgłaszają błędy 401.", {
        adlook_token: z.string().min(1).optional()
            .describe("Opcjonalny token do sprawdzenia; jeśli nie podasz, sprawdza token sesji / ADLOOK_TOKEN z env."),
    }, async ({ adlook_token }) => {
        try {
            const token = await resolveAccessToken(adlook_token);
            const parts = token.split(".");
            if (parts.length !== 3) {
                return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Token nie wygląda jak JWT (oczekiwane 3 segmenty base64)." }) }], isError: true };
            }
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
            const now = Math.floor(Date.now() / 1000);
            const exp = payload.exp;
            const expired = exp !== undefined ? exp < now : false;
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            ok: !expired,
                            expired,
                            expires_at: exp ? new Date(exp * 1000).toISOString() : null,
                            expires_in_seconds: exp ? exp - now : null,
                            user_uuid: payload.user_uuid ?? null,
                            permissions: payload.permissions ?? null,
                            auto_refresh: isOAuthRefreshConfigured(),
                        }, null, 2),
                    }],
                ...(expired ? { isError: true } : {}),
            };
        }
        catch (err) {
            return { content: [{ type: "text", text: `Błąd: ${err.message}` }], isError: true };
        }
    });
    // ── Zasób MCP: katalog metryk ─────────────────────────────────────────────────
    server.resource("metrics-catalog", "adlook://metrics-catalog", {
        description: "Pełny katalog metryk dostępnych w Adlook Custom Reports, " +
            "wraz z nazwami, opisami i przynależnością do grup " +
            "(AUDIO, VIDEO, PERFORMANCE, CONVERSIONS, COST, PAGE_VISITS, UNIQUES).",
        mimeType: "application/json",
    }, async () => ({
        contents: [
            {
                uri: "adlook://metrics-catalog",
                mimeType: "application/json",
                text: JSON.stringify(METRICS_CATALOG, null, 2),
            },
        ],
    }));
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
}
else {
    // Tryb HTTP/SSE dla deploymentu zespołowego
    const app = express();
    // Uwaga: NIE podpinamy globalnego parsera JSON.
    // MCP transport potrzebuje surowego strumienia requestu na /message.
    // Mapa sesji SSE: sessionId → transport
    const sseSessions = new Map();
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
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[MCP] Błąd SSE: ${message}`);
            if (!res.headersSent)
                res.status(500).end();
        }
    });
    // Message endpoint — klient wysyła wiadomości tutaj
    app.post("/message", async (req, res) => {
        const sessionId = req.query.sessionId;
        const transport = sseSessions.get(sessionId);
        if (!transport) {
            console.warn(`[MCP] Nieznany sessionId: ${sessionId}`);
            res.status(400).json({ error: `Nieznana sesja: ${sessionId}` });
            return;
        }
        try {
            await transport.handlePostMessage(req, res);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[MCP] Błąd /message (sesja: ${sessionId}): ${message}`);
            if (!res.headersSent)
                res.status(500).json({ error: message });
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
    app.use((err, _req, res, _next) => {
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
