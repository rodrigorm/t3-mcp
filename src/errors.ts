export type ConnectorErrorCode =
  | "invalid_input"
  | "insecure_endpoint"
  | "missing_grant"
  | "upstream_incompatible"
  | "pairing_rejected"
  | "permission_denied"
  | "session_expired"
  | "project_not_found"
  | "thread_not_found"
  | "transport_error"
  | "dispatch_failed"
  | "unknown_outcome"
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
