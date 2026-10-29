import type { Check } from "../types.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchedFile {
  url: string;
  status?: number;
  /** Redirect target, when the server answered with a 3xx. */
  location?: string;
  contentType?: string;
  /** Uncompressed size in bytes. */
  size?: number;
  json?: unknown;
  jsonError?: string;
  networkError?: string;
}

const NETWORK_ERRORS: Record<string, string> = {
  ENOTFOUND: "the domain name doesn't resolve (no DNS record)",
  EAI_AGAIN: "the domain name couldn't be resolved (DNS lookup failed)",
  ECONNREFUSED: "the server refused the connection on port 443",
  ECONNRESET: "the server closed the connection",
  CERT_HAS_EXPIRED: "its TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "it uses a self-signed TLS certificate, which devices don't trust",
  SELF_SIGNED_CERT_IN_CHAIN: "its TLS certificate chain includes a self-signed certificate, which devices don't trust",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its TLS certificate chain is incomplete (missing intermediate certificate)",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "its TLS certificate chain is incomplete (missing intermediate certificate)",
  ERR_TLS_CERT_ALTNAME_INVALID: "its TLS certificate doesn't cover this domain name",
};

function describeNetworkError(error: unknown): string {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err.name === "TimeoutError" || err.name === "AbortError") return "the request timed out";
  const code = err.cause?.code;
  if (code && NETWORK_ERRORS[code]) return NETWORK_ERRORS[code];
  return code ?? err.cause?.message ?? err.message ?? String(error);
}

/** Fetch an association file without following redirects, since Apple and Google don't either. */
export async function fetchFile(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 10_000): Promise<FetchedFile> {
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "user-agent": "rn-deeplink (association file check)" },
    });
    const result: FetchedFile = { url, status: response.status, contentType: response.headers.get("content-type") ?? undefined };
    if (response.status >= 300 && response.status < 400) return { ...result, location: response.headers.get("location") ?? undefined };
    if (response.status !== 200) return result;
    const body = new Uint8Array(await response.arrayBuffer());
    result.size = body.byteLength;
    try {
      result.json = JSON.parse(new TextDecoder().decode(body).replace(/^﻿/, ""));
    } catch (error) {
      result.jsonError = (error as Error).message;
    }
    return result;
  } catch (error) {
    return { url, networkError: describeNetworkError(error) };
  }
}

export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Short description of why a fetch didn't produce a usable file, e.g. "404" or "redirects to …". */
export function describeFailure(file: FetchedFile): string {
  if (file.networkError) return file.networkError;
  if (file.location) return `redirects to ${file.location}`;
  if (file.status !== 200) return `HTTP ${file.status}`;
  return "not valid JSON";
}

/**
 * Checks that apply to both association files: reachable over HTTPS, 200 without redirects,
 * JSON body and Content-Type. `usable` is true when the body parsed as JSON.
 */
export function servedChecks(file: FetchedFile, platform: "iOS" | "Android"): { usable: boolean; checks: Check[] } {
  const { url } = file;
  if (file.networkError) {
    return {
      usable: false,
      checks: [
        {
          level: "error",
          message: `Couldn't fetch ${url}: ${file.networkError}.`,
          fix: "The domain must serve HTTPS on port 443 with a certificate from a trusted authority.",
        },
      ],
    };
  }
  if (file.location !== undefined || (file.status !== undefined && file.status >= 300 && file.status < 400)) {
    return {
      usable: false,
      checks: [
        {
          level: "error",
          message: `${url} redirects (${file.status}) to ${file.location ?? "another URL"}. ${platform} doesn't follow redirects for this file.`,
          fix: "Serve the file directly at this URL with status 200. If you redirect between example.com and www.example.com, serve the file on both hosts.",
        },
      ],
    };
  }
  if (file.status !== 200) {
    return {
      usable: false,
      checks: [
        {
          level: "error",
          message: `${url} returned HTTP ${file.status}${file.status === 404 ? " (not found)" : ""}.`,
          fix:
            file.status === 404
              ? "Upload the file to this path. If your host serves a single-page app, make sure /.well-known/ isn't rewritten to index.html."
              : "The file must be publicly reachable with status 200, without authentication, bot protection or geo-blocking.",
        },
      ],
    };
  }
  if (file.json === undefined) {
    const html = /text\/html/i.test(file.contentType ?? "");
    return {
      usable: false,
      checks: [
        html
          ? {
              level: "error",
              message: `${url} returns an HTML page instead of the file. A catch-all route (often a single-page app's index.html fallback) is answering this URL.`,
              fix: "Serve the real JSON file at this path, before your catch-all route.",
            }
          : {
              level: "error",
              message: `${url} is not valid JSON (${file.jsonError}).`,
              fix: "Fix the JSON syntax; a validator such as `npx jsonlint` shows where it breaks.",
            },
      ],
    };
  }

  const checks: Check[] = [
    { level: "pass", message: `Served at ${url} (200, ${file.contentType ?? "no Content-Type"}, ${formatSize(file.size ?? 0)})` },
  ];
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(file.contentType ?? "")) {
    checks.push({
      level: platform === "Android" ? "error" : "warning",
      message: `It is served as ${file.contentType ? `"${file.contentType}"` : "no Content-Type"} instead of application/json.`,
      fix: "Set Content-Type: application/json for this path on your server or CDN.",
    });
  }
  return { usable: true, checks };
}
