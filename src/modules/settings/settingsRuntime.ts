import { apiJson } from '../../lib/api-client';

export type SettingsRuntime = {
  company: { companyName: string; workspaceName: string; timezone: string; currency: string; locale: string; defaultLanguage?: string };
  roles: { users: Array<{ id: string; name: string; email: string; role: string; enabled: boolean }>; roleOptions: string[] };
  numbering: { rules: Array<{ id: string; document: string; prefix: string; datePattern: string; separator: string; sequenceLength: number; nextSequence: number }> };
  review: {
    policies: Array<{ id: string; name: string; enabled: boolean; reviewerRoles: string[] }>; amountThreshold: number; riskLevels: string[]; inventoryTolerancePercent: number; reviewerRoles: string[]; enabled: boolean;
    // Invoice matching tolerances, stored as decimal strings. Three-way match applies these.
    quantityTolerance: string; pricePercentageTolerance: string; priceAbsoluteTolerance: string; amountTolerance: string;
  };
  modules: { defaultModule: string; items: Array<{ id: string; label: string; enabled: boolean; order: number; roles: string[] }> };
  ai: { capabilities: Array<{ id: string; label: string; level: string }>; evidenceRequired: boolean; retainDays: number };
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
