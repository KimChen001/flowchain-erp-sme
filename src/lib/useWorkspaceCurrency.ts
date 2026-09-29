import { useEffect, useState } from "react";
import { useI18n } from "../i18n/I18n";
import { apiJson } from "./api-client";
import { DEFAULT_WORKSPACE_TIMEZONE } from "./format";

export const DEFAULT_WORKSPACE_CURRENCY = "USD";

type WorkspaceCompanySettings = { company?: { currency?: string; timezone?: string } };

export type WorkspaceCurrencyState = {
  /** Workspace currency; "" while loading or when the settings could not be read. */
  currency: string;
  /** Workspace timezone, falling back to the loaded localization timezone, then America/New_York. */
  timezone: string;
  status: "loading" | "ready" | "unavailable";
};

/**
 * Reads the workspace business defaults from /api/settings-runtime.
 * A workspace without a stored currency defaults to USD. When the settings
 * cannot be read the currency stays "" so forms ask the user to choose one
 * instead of silently stamping a guessed currency on stored documents.
 */
export function useWorkspaceCurrency(): WorkspaceCurrencyState {
  const { timezone: localizationTimezone } = useI18n();
  const [settings, setSettings] = useState<{ currency: string; timezone: string; status: WorkspaceCurrencyState["status"] }>({ currency: "", timezone: "", status: "loading" });
  useEffect(() => {
    let active = true;
    apiJson<WorkspaceCompanySettings>("/api/settings-runtime")
      .then((payload) => {
        if (!active) return;
        setSettings({
          currency: String(payload?.company?.currency || "").trim().toUpperCase() || DEFAULT_WORKSPACE_CURRENCY,
          timezone: String(payload?.company?.timezone || "").trim(),
          status: "ready",
        });
      })
      .catch(() => {
        if (active) setSettings({ currency: "", timezone: "", status: "unavailable" });
      });
    return () => { active = false; };
  }, []);
  return {
    currency: settings.currency,
    timezone: settings.timezone || localizationTimezone || DEFAULT_WORKSPACE_TIMEZONE,
    status: settings.status,
  };
}
