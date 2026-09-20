export type ConnectorErrorCode =
  | "invalid_input"
  | "insecure_endpoint"
  | "missing_grant"
  | "upstream_incompatible"
  | "pairing_rejected"
  | "permission_denied"
  | "transport_error"
  | "environment_exists"
  | "environment_not_found"
  | "environment_conflict"
  | "storage_error"
  | "internal_error";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}
