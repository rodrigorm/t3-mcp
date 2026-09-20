import net from "node:net";

import { ConnectorError } from "./errors.js";

export interface ValidatedEndpoint {
  readonly baseUrl: URL;
  readonly grant: string;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  if (net.isIP(normalized) === 4) {
    return normalized.split(".")[0] === "127";
  }

  return false;
}

function readGrantFromParameters(
  params: URLSearchParams,
  source: "fragment" | "query",
): string | undefined {
  const entries = Array.from(params.entries());
  if (entries.length === 0) {
    return undefined;
  }

  const grant = entries.length === 1 && entries[0][0] === "token" ? entries[0][1].trim() : "";
  if (!grant) {
    throw new ConnectorError(
      source === "query" ? "insecure_endpoint" : "invalid_input",
      source === "query"
        ? "Pairing URL query parameters must contain only token."
        : "The pairing URL fragment must contain only token.",
    );
  }
  return grant;
}

function readGrantFromFragment(url: URL): string | undefined {
  if (url.hash.length === 0) {
    return undefined;
  }
  return readGrantFromParameters(new URLSearchParams(url.hash.slice(1)), "fragment");
}

function readGrantFromQuery(url: URL, allowQueryGrant: boolean): string | undefined {
  if (url.search.length === 0) {
    return undefined;
  }
  if (!allowQueryGrant) {
    throw new ConnectorError(
      "insecure_endpoint",
      "Endpoint credentials and query parameters are not accepted.",
    );
  }
  return readGrantFromParameters(url.searchParams, "query");
}

function withoutPairPath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized === "/pair" || normalized.endsWith("/pair")) {
    return `${normalized.slice(0, -"/pair".length) || ""}/`;
  }
  return `${normalized || ""}/`.replace(/^$/, "/");
}

export function parseEndpoint(
  input: string,
  explicitGrant?: string,
  allowQueryGrant = false,
): ValidatedEndpoint {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ConnectorError("invalid_input", "Endpoint must be an absolute HTTP(S) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("invalid_input", "Endpoint must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new ConnectorError(
      "insecure_endpoint",
      "Endpoint credentials and query parameters are not accepted.",
    );
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new ConnectorError(
      "insecure_endpoint",
      "Non-loopback environments must use HTTPS.",
    );
  }

  const queryGrant = readGrantFromQuery(url, allowQueryGrant);
  const fragmentGrant = readGrantFromFragment(url);
  if (queryGrant && fragmentGrant && queryGrant !== fragmentGrant) {
    throw new ConnectorError("invalid_input", "The pairing URL grants do not match.");
  }
  const urlGrant = queryGrant || fragmentGrant;
  const grant = explicitGrant?.trim() || urlGrant;
  if (!grant) {
    throw new ConnectorError("missing_grant", "A pairing grant is required.");
  }
  if (explicitGrant?.trim() && urlGrant && explicitGrant.trim() !== urlGrant) {
    throw new ConnectorError("invalid_input", "The pairing URL and grant do not match.");
  }

  url.pathname = withoutPairPath(url.pathname);
  url.search = "";
  url.hash = "";
  return { baseUrl: url, grant };
}

export function endpointPath(baseUrl: URL, path: string): URL {
  const result = new URL(baseUrl.toString());
  result.pathname = `${result.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  result.search = "";
  result.hash = "";
  return result;
}

export function publicEndpoint(baseUrl: URL): string {
  const result = new URL(baseUrl.toString());
  result.username = "";
  result.password = "";
  result.search = "";
  result.hash = "";
  return result.toString();
}
