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
export {};
