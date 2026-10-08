import { apiJson } from '../../lib/api-client';
import type { DocumentSettings } from '../../../shared/business-documents.mjs';

export type SettingsRuntime = {
  company: { companyName: string; workspaceName: string; timezone: string; currency: string; locale: string; defaultLanguage?: string };
  roles: { users: Array<{ id: string; name: string; email: string; role: string; enabled: boolean }>; roleOptions: string[] };
  numbering: { rules: Array<{ id: string; document: string; prefix: string; datePattern: string; separator: string; sequenceLength: number; nextSequence: number }> };
  review: {
    policies: Array<{ id: string; name: string; enabled: boolean; reviewerRoles: string[] }>; amountThreshold: number; riskLevels: string[]; inventoryTolerancePercent: number; reviewerRoles: string[]; enabled: boolean;
    // Invoice matching tolerances, stored as decimal strings. Three-way match applies these.
    quantityTolerance: string; pricePercentageTolerance: string; priceAbsoluteTolerance: string; amountTolerance: string;
    // A PO created from an approved purchase request is approved with it (default on).
    approvedRequestApprovesPurchaseOrder?: boolean;
  };
  modules: { defaultModule: string; items: Array<{ id: string; label: string; enabled: boolean; order: number; roles: string[] }> };
  ai: { modelAssistEnabled?: boolean; capabilities: Array<{ id: string; label: string; level: string }>; evidenceRequired: boolean; retainDays: number };
  advanced: { sessionTimeoutMinutes: number; exportLimit: number; dateFormat: string; negativeInventoryBlocked: boolean; maintenanceNotice: string };
};

export type SettingsAuditEntry = {
  id: string; timestamp: string; summary: string; module: string; action: string;
  actor?: { name?: string; role?: string }; entity?: { type?: string; id?: string }; before?: unknown; after?: unknown;
};

export const fetchSettingsRuntime = () => apiJson<SettingsRuntime>('/api/settings-runtime');

export async function saveSettingsSection<K extends keyof SettingsRuntime>(section: K, settings: SettingsRuntime[K]) {
  return apiJson<{ settings: SettingsRuntime[K] }>(`/api/settings-runtime/${section}`, {
    method: 'PATCH', body: JSON.stringify({ settings }),
  });
}

export const fetchSettingsAudit = () => apiJson<SettingsAuditEntry[]>('/api/audit-log?limit=200');

// The workspace's AI status (server/domain/ai-workspace-access.mjs).
export type AiWorkspaceStatus = {
  status: 'no_provider' | 'on' | 'off' | 'over_cap';
  providerConfigured: boolean; optInRequired: boolean; enabled: boolean;
  month: string; calls: number; costUsd: number; capUsd: number;
};
export const fetchAiWorkspaceStatus = () => apiJson<AiWorkspaceStatus>('/api/settings-runtime/ai-status');

// The documents section (letterhead and PO template), kept apart from
// SettingsRuntime because it has its own form under Company & workspace.
export const fetchDocumentSettings = () => apiJson<{ documents: DocumentSettings }>('/api/settings-runtime').then((settings) => settings.documents);
export const saveDocumentSettings = (settings: DocumentSettings) =>
  apiJson<{ settings: DocumentSettings }>('/api/settings-runtime/documents', { method: 'PATCH', body: JSON.stringify({ settings }) });
