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
  | "thread_busy"
  | "approval_required"
  | "input_required"
  | "dispatch_conflict"
  | "transport_error"
  | "dispatch_failed"
  | "unknown_outcome"
  | "environment_exists"
  | "environment_not_found"
  | "environment_conflict"
  | "connect_not_configured"
  | "connect_auth_pending"
  | "connect_auth_failed"
  | "connect_auth_cancelled"
  | "connect_auth_expired"
  | "connect_account_conflict"
  | "connect_permission_denied"
  | "connect_unavailable"
  | "connect_environment_not_found"
  | "connect_identity_mismatch"
  | "connect_endpoint_invalid"
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
