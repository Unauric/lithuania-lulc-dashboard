// Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
// See LICENSE in the repository root -- source reuse is restricted to LEI.
//
// CORS-enabling proxy for api.meteo.lt's hydro-stations API.
//
// api.meteo.lt does not send an Access-Control-Allow-Origin header, so a
// browser blocks a direct fetch() to it from any other origin (including a
// GitHub Pages-hosted copy of this dashboard). serve_dashboard.py works
// around this locally by proxying the request through its own Python
// server -- but GitHub Pages only serves static files, it can't run that
// script. This Worker does the exact same job (fetch api.meteo.lt
// server-side, where CORS doesn't apply, then hand the response back with
// an Access-Control-Allow-Origin header added) as a small always-on
// service instead, so a fully static deploy still gets live hydro data for
// every visitor.
//
// Same /api/hydro/<path> -> https://api.meteo.lt/v1/<path> mapping as
// serve_dashboard.py's _proxy_hydro, so app.js's HYDRO_API_PROXY only needs
// a different base URL once this is deployed -- no other code changes.
//
// Deploy (no CLI needed): see README.md in this folder.

const UPSTREAM_BASE = "https://api.meteo.lt/v1/";
const PROXY_PREFIX = "/api/hydro/";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      // CORS preflight -- browsers send this before the real GET whenever
      // the request looks "non-simple" to them; a bare 204 with the CORS
      // headers is all it needs.
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }
    if (!url.pathname.startsWith(PROXY_PREFIX)) {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    const upstreamPath = url.pathname.slice(PROXY_PREFIX.length);
    if (!upstreamPath || upstreamPath.includes("..")) {
      return new Response("Bad request", { status: 400, headers: CORS_HEADERS });
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(UPSTREAM_BASE + upstreamPath, {
        headers: { "User-Agent": "lithuania-dashboard/1.0" },
        // api.meteo.lt's data changes at most hourly (see
        // serve_dashboard.py's own comment) and repeated clicks on the same
        // station/date shouldn't re-hit the upstream API every time -- same
        // reasoning as the Python proxy's in-memory cache, just via
        // Cloudflare's edge cache (shared across every visitor, not just
        // one process) instead of a local dict.
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: `Upstream fetch failed: ${e}` }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const body = await upstreamResp.arrayBuffer();
    return new Response(body, {
      status: upstreamResp.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstreamResp.headers.get("Content-Type") || "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};
