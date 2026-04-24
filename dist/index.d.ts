#!/usr/bin/env node
/**
 * Adlook Smart API — Custom Reports Previews
 * MCP Server
 *
 * Narzędzia:
 *   set_adlook_auth        – tokeny z przeglądarki na sesję (pamięć procesu)
 *   create_report_preview  – POST /api/custom-reports/previews
 *   get_report_preview     – GET  /api/custom-reports/previews/{uuid}
 *   run_report_preview     – POST + polling GET aż do SUCCEEDED / FAILED
 */
export {};
