import { useCallback, useMemo } from "react";
import { ApiError, apiJson, AUTH_TOKEN_KEY } from "../../lib/api-client";
import { documentToneStyle, type DocumentTone } from "../../components/document/DocumentShell";
import { formatCalendarDay, formatDateTimeInTimeZone, formatLocaleAmount } from "../../lib/format";
import { useI18n } from "../../i18n/I18n";
import { contractCopy } from "./contractCopy";
import {
  CONTRACT_MAX_NOTICE_DAYS,
  CONTRACT_MAX_REMINDER_DAYS,
  type ContractKeyDateKind,
  type ContractRenewal,
  type ContractState,
  type ContractStatus,
  type ContractType,
} from "../../../shared/contract-status.mjs";

// What the Contracts pages share (docs/contracts-module-design.md, K1): the
// API shapes of /api/contracts, the words for its codes, the state chip and
// the errors in the interface language. The server sends codes, ids and
// calendar days; these pages write the words, never the codes.

export type { ContractRenewal, ContractState, ContractType };
export type Person = { id: string; name: string | null };

export type ContractView = {
  id: string;
  number: string;
  title: string;
  externalReference: string | null;
  type: ContractType;
  supplierId: string | null;
  ownerId: string | null;
  startDate: string | null;
  endDate: string | null;
  signedOn: string | null;
  renewal: ContractRenewal;
  noticeDays: number;
  reminderDays: number;
  paymentTermsId: string | null;
  currency: string | null;
  totalValue: string | null;
  notes: string | null;
  supplier: { id: string; code: string | null; name: string } | null;
  owner: Person | null;
  status: ContractStatus;
  state: ContractState;
  keyDate: string | null;
  keyDateKind: ContractKeyDateKind | null;
  daysUntilKeyDate: number | null;
  noticeDeadline: string | null;
  inReminderWindow: boolean;
  renewsContract: { id: string; number: string } | null;
  renewals: Array<{ id: string; number: string; status: ContractStatus; activatedAt: string | null }>;
  terminatedOn: string | null;
  terminationReason: string | null;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  activatedAt: string | null;
  restrictedFields: string[];
};
export type ContractFile = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string | null;
  createdBy: Person;
  downloadUrl: string;
};
export type ContractHistoryRow = {
  id: string;
  action: string;
  at: string | null;
  actor: Person | null;
  summary: string | null;
  details: Record<string, any>;
};
export type ContractAccess = { manage: boolean; prices: boolean };
export type ContractCounts = Record<"all" | ContractState, number>;
export type ContractList = {
  today: string;
  contracts: ContractView[];
  total: number;
  page: number;
  pageSize: number;
  counts: ContractCounts;
  access: ContractAccess;
  limitations: string[];
};
export type ContractDetail = {
  today: string;
  contract: ContractView & { files: ContractFile[]; history: ContractHistoryRow[] };
  access: ContractAccess;
};

export const CONTRACT_PAGE_SIZE = 200;
export const TYPE_LABEL: Record<ContractType, string> = {
  purchase_agreement: "Purchase agreement",
  service_agreement: "Service agreement",
  nda: "NDA",
  quality_agreement: "Quality agreement",
  other: "Other",
};
export const STATE_LABEL: Record<ContractState, string> = {
  draft: "Draft",
  active: "Active",
  notice_due: "Notice due",
  ending: "Ending soon",
  past_end: "Past end date",
  ended: "Ended",
  renewed: "Renewed",
  terminated: "Terminated",
};
export const RENEWAL_LABEL: Record<ContractRenewal, string> = {
  none: "Does not renew",
  automatic: "Renews automatically",
  by_agreement: "Renew by agreement",
};
// The states on Ending soon, and what each asks of the reader.
export const ENDING_STATES: ContractState[] = ["notice_due", "ending", "past_end"];
export const STATE_EXPLANATION: Partial<Record<ContractState, string>> = {
  notice_due: "It renews automatically unless notice is given by the notice deadline.",
  ending: "The end date is inside the reminder window. Renew it or let it end.",
  past_end: "It renews automatically and its end date has passed. Record the new end date.",
};
// The brand status rules: green for in force, orange for what needs action
// soon, red for what is past due, gray for drafts and closed contracts.
const STATE_TONE: Record<ContractState, DocumentTone> = {
  draft: "neutral",
  active: "success",
  notice_due: "warning",
  ending: "warning",
  past_end: "danger",
  ended: "neutral",
  renewed: "neutral",
  terminated: "neutral",
};

export function useContractCopy() {
  const { language } = useI18n();
  return useCallback((value: string, variables: Record<string, string | number> = {}) => contractCopy(value, language, variables), [language]);
}

// Calendar days as entered, money in the contract's currency, instants in
// the workspace timezone, all in the workspace locale.
export function useContractFormat() {
  const { locale, timezone } = useI18n();
  return useMemo(() => ({
    day: (value: string | null | undefined) => formatCalendarDay(value, locale),
    instant: (value: string | null | undefined) => formatDateTimeInTimeZone(value, locale, timezone),
    money: (value: string | null | undefined, currency: string | null | undefined) => {
      if (value === null || value === undefined || value === "") return "—";
      const amount = Number(value);
      return Number.isFinite(amount) ? formatLocaleAmount(amount, currency, locale, { maximumFractionDigits: 4 }) : "—";
    },
    size: (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`),
  }), [locale, timezone]);
}

export function ContractStateChip({ state, testId = "contract-state-chip" }: { state: ContractState; testId?: string }) {
  const t = useContractCopy();
  const style = documentToneStyle(STATE_TONE[state] || "neutral");
  return (
    <span className="fc-status-chip inline-flex w-fit items-center whitespace-nowrap" data-testid={testId} data-state={state} style={{ color: style.color, background: style.bg }}>
      {t(STATE_LABEL[state] || "Changed")}
    </span>
  );
}

// The key date and what it is: the last day to give notice, the end date, or
// the day it was terminated.
export function keyDateLabel(contract: Pick<ContractView, "keyDateKind" | "daysUntilKeyDate">) {
  if (contract.keyDateKind === "notice_deadline") return "Notice by";
  if (contract.keyDateKind === "terminated") return "Terminated on";
  if (contract.keyDateKind === "end") return contract.daysUntilKeyDate !== null && contract.daysUntilKeyDate < 0 ? "Ended" : "Ends";
  return "";
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const path = (id: string, suffix = "") => `/api/contracts/${encodeURIComponent(id)}${suffix}`;
type Saved = { contract: ContractView | null };
export const contractsApi = {
  list: (params: URLSearchParams) => apiJson<ContractList>(`/api/contracts?${params}`),
  get: (id: string) => apiJson<ContractDetail>(path(id)),
  create: (body: Record<string, unknown>) => apiJson<Saved>("/api/contracts", { method: "POST", ...json(body) }),
  update: (id: string, body: Record<string, unknown>) => apiJson<Saved>(path(id), { method: "PATCH", ...json(body) }),
  activate: (id: string, body: Record<string, unknown>) => apiJson<Saved>(path(id, "/activate"), { method: "POST", ...json(body) }),
  terminate: (id: string, body: Record<string, unknown>) => apiJson<Saved>(path(id, "/terminate"), { method: "POST", ...json(body) }),
  renew: (id: string, body: Record<string, unknown>) => apiJson<Saved>(path(id, "/renew"), { method: "POST", ...json(body) }),
  deleteDraft: (id: string, version: number) => apiJson<{ deleted: boolean }>(`${path(id)}?expectedVersion=${version}`, { method: "DELETE" }),
  addFile: (id: string, body: Record<string, unknown>) => apiJson<Saved>(path(id, "/attachments"), { method: "POST", ...json(body) }),
  removeFile: (id: string, attachmentId: string, version: number) => apiJson<Saved>(`${path(id, `/attachments/${encodeURIComponent(attachmentId)}`)}?expectedVersion=${version}`, { method: "DELETE" }),
  stage: (body: Record<string, unknown>) => apiJson<{ uploadId: string }>("/api/uploads/stage", { method: "POST", ...json(body) }),
};

export async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

// Files download through the authorized endpoint with the session's token;
// there is no public link.
export async function downloadContractFile(file: ContractFile) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
  const response = await fetch(file.downloadUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(String(response.status));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const CONTRACT_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
export const CONTRACT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const FIELD_LIMITS: Record<string, number> = { title: 200, externalReference: 100, notes: 4000, reason: 1000, terminationReason: 1000, paymentTermsId: 64 };
const REQUIRED: Record<string, string> = {
  title: "Enter a title.",
  type: "Choose a contract type.",
  supplierId: "Choose a supplier.",
  signedOn: "An active contract needs its signed date and start date.",
  startDate: "An active contract needs its signed date and start date.",
  terminatedOn: "Enter the termination date.",
  reason: "Enter why the contract was terminated.",
  uploadId: "Upload the file first.",
};
export type FieldIssue = { field: string; code: string };

// A field error from a 422's details, in the interface language.
export function fieldIssueText(issue: FieldIssue, t: (value: string, variables?: Record<string, string | number>) => string) {
  switch (issue.code) {
    case "REQUIRED": return t(REQUIRED[issue.field] || "Check this field.");
    case "TOO_LONG": return t("Use at most {max} characters.", { max: FIELD_LIMITS[issue.field] ?? "" });
    case "INVALID": return t(issue.field === "renewal" ? "Choose how the contract renews." : issue.field === "type" ? "Choose a contract type." : "Check this field.");
    case "DATE_INVALID": return t("Enter a date as YYYY-MM-DD.");
    case "WHOLE_NUMBER_REQUIRED": return t("Enter a whole number of days from 0 to {max}.", { max: issue.field === "noticeDays" ? CONTRACT_MAX_NOTICE_DAYS : CONTRACT_MAX_REMINDER_DAYS });
    case "CURRENCY_INVALID": return t("Choose a valid currency.");
    case "AMOUNT_INVALID": return t("Enter an amount of 0 or more with at most four decimal places.");
    case "END_BEFORE_START": return t("The end date must be on or after the start date.");
    case "SIGNED_ON_IN_FUTURE": return t("The signed date cannot be after today.");
    case "BEFORE_SIGNED_ON": return t("The termination date cannot be before the signed date.");
    case "SUPPLIER_NOT_FOUND": return t("Choose a supplier of this workspace.");
    case "OWNER_NOT_FOUND": return t("Choose an active user of this workspace.");
    case "PAYMENT_TERM_NOT_FOUND": return t("Choose one of the workspace payment terms.");
    case "LOCKED": return t("An active contract keeps its supplier and type.");
    case "NO_FIELDS": return t("Nothing changed.");
    default: return t("Check this field.");
  }
}

export function fieldIssues(error: unknown): FieldIssue[] {
  if (!(error instanceof ApiError) || error.status !== 422) return [];
  return error.details
    .map((detail) => ({ field: String(detail.field || ""), code: String(detail.code || "") }))
    .filter((issue) => issue.field);
}

// Any error from the contract, upload and download endpoints, in the
// interface language. A version conflict also offers a reload.
export function contractErrorText(error: unknown, t: (value: string, variables?: Record<string, string | number>) => string) {
  if (!(error instanceof ApiError)) return t("The request could not be completed. Try again.");
  const code = String(error.code || "");
  if (error.status === 401) return t("Your session has ended. Sign in again.");
  if (error.status === 403) return t("Your role does not allow this.");
  switch (code) {
    case "VERSION_CONFLICT": return t("This contract was changed by someone else. Reload it to see the latest version.");
    case "CONTRACT_RENEWAL_EXISTS": return t("This contract already has a renewal: {number}.", { number: String((error.payload as Record<string, unknown>)?.renewalNumber || "") });
    case "INVALID_STATE_TRANSITION": return t("This contract's status changed. Reload it and try again.");
    case "CONTRACT_NOT_EDITABLE": return t("A terminated contract cannot be edited.");
    case "CONTRACT_FIELD_LOCKED": return t("The supplier and type of an active contract cannot change. Renew it instead.");
    case "CONTRACT_NOT_RENEWABLE": return t("Only an active contract can be renewed.");
    case "CONTRACT_NOT_DRAFT": return t("Only a draft contract can be deleted.");
    case "CONTRACT_UNCHANGED": return t("Nothing changed.");
    case "VALIDATION_ERROR": return t("Check the highlighted fields.");
    case "CONTRACT_NOT_FOUND": return t("This contract was not found. It may have been deleted.");
    case "CONTRACTS_CAPABILITY_NOT_AVAILABLE": return t("Contracts are not turned on for this workspace.");
    case "TRANSACTION_CONFLICT":
    case "CONTRACT_CONFLICT":
    case "COMMAND_EXECUTION_IN_PROGRESS":
    case "VERSION_INVALID": return t("Another change landed at the same time. Reload and try again.");
    case "CONTRACT_REQUEST_TOO_LARGE":
    case "UPLOAD_SIZE_INVALID":
    case "UPLOAD_TYPE_NOT_ALLOWED":
    case "CONTRACT_FILE_TYPE_NOT_ALLOWED": return t("A signed file must be a PDF or an image (JPEG, PNG or WebP) of at most 20 MB.");
    case "UPLOAD_NOT_FOUND":
    case "UPLOAD_NOT_BINDABLE":
    case "UPLOAD_CONTENT_INVALID":
    case "UPLOAD_HASH_MISMATCH": return t("The file could not be uploaded. Try again.");
    case "ATTACHMENT_NOT_FOUND": return t("This file was already removed. Reload the contract.");
    case "ATTACHMENT_HASH_MISMATCH": return t("The stored file failed its integrity check. Ask an administrator.");
    case "ATTACHMENT_CAPABILITY_NOT_AVAILABLE": return t("File storage is not available right now.");
    default:
      if (code.startsWith("ATTACHMENT_STORAGE")) return t("File storage is not available right now.");
      return t("The request could not be completed. Try again.");
  }
}

export const isVersionConflict = (error: unknown) => error instanceof ApiError && error.status === 409 && ["VERSION_CONFLICT", "INVALID_STATE_TRANSITION", "TRANSACTION_CONFLICT", "CONTRACT_CONFLICT"].includes(String(error.code));
