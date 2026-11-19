/**
 * Text for a failed API response.
 *
 * A string `detail` is the message. A range iceberg 409 sends an object
 * `{accepted, reason, executor_id}`, and the toast shows `reason`. A 422
 * sends a list of field errors.
 */

const ALREADY_OPEN = /(A range iceberg is already open on \S+ )(BUY|SELL)( for\b)/i;

/** LONG and SHORT in the one-open iceberg refusal. Other text is unchanged. */
export function positionSideNotice(message: string): string {
  return message.replace(ALREADY_OPEN, (_match, lead: string, side: string, rest: string) => {
    const word = side.toUpperCase() === "SELL" ? "SHORT" : "LONG";
    return `${lead}${word}${rest}`;
  });
}

function fieldError(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const row = item as { msg?: unknown; loc?: unknown };
  if (typeof row.msg !== "string" || !row.msg.trim()) return "";
  const where = Array.isArray(row.loc)
    ? row.loc.map(String).filter((part) => part && part !== "body").join(".")
    : "";
  return where ? `${where}: ${row.msg.trim()}` : row.msg.trim();
}

function detailText(detail: unknown): string {
  if (typeof detail === "string") return detail.trim();
  if (Array.isArray(detail)) {
    return detail.map(fieldError).filter(Boolean).join("; ");
  }
  if (detail && typeof detail === "object") {
    const reason = (detail as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
    if ("detail" in detail) return detailText((detail as { detail?: unknown }).detail);
  }
  return "";
}

/** The sentence a toast should show for this error body. */
export function apiErrorMessage(body: unknown, status: number): string {
  const detail = body && typeof body === "object" && "detail" in body
    ? (body as { detail?: unknown }).detail
    : undefined;
  const text = detailText(detail);
  if (text) return positionSideNotice(text);
  return `Request failed: ${status}`;
}

/** Success line after an accepted range iceberg edit. */
export function editAcceptedMessage(reason: unknown): string {
  return typeof reason === "string" && reason.trim() ? reason.trim() : "Range iceberg updated.";
}
