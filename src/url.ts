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

function readGrantFromFragment(url: URL): string | undefined {
  if (url.hash.length === 0) {
    return undefined;
  }

  const params = new URLSearchParams(url.hash.slice(1));
  const grant = params.get("token")?.trim();
  if (!grant || Array.from(params.keys()).some((key) => key !== "token")) {
    throw new ConnectorError("invalid_input", "The pairing URL fragment must contain only token.");
  }
  return grant;
}

function withoutPairPath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized === "/pair" || normalized.endsWith("/pair")) {
    return `${normalized.slice(0, -"/pair".length) || ""}/`;
  }
  return `${normalized || ""}/`.replace(/^$/, "/");
}

export function parseEndpoint(input: string, explicitGrant?: string): ValidatedEndpoint {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ConnectorError("invalid_input", "Endpoint must be an absolute HTTP(S) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("invalid_input", "Endpoint must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search) {
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

  const fragmentGrant = readGrantFromFragment(url);
  const grant = explicitGrant?.trim() || fragmentGrant;
  if (!grant) {
    throw new ConnectorError("missing_grant", "A pairing grant is required.");
  }
  if (explicitGrant?.trim() && fragmentGrant && explicitGrant.trim() !== fragmentGrant) {
    throw new ConnectorError("invalid_input", "The pairing URL and grant do not match.");
  }

  url.pathname = withoutPairPath(url.pathname);
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
