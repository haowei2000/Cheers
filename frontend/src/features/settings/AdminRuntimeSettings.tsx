import { useCallback, useEffect, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { Banner } from "@/components/ui/banner";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { SettingsCard, SettingsSection } from "@/components/ui/settings-card";
import { Textarea } from "@/components/ui/textarea";
import toast from "react-hot-toast";
import { History, SlidersHorizontal } from "lucide-react";
import { useIsAdmin } from "@/stores/authStore";
import {
  listRuntimeSettingRevisions,
  listRuntimeSettings,
  putRuntimeSetting,
  type RuntimeSetting,
  type RuntimeSettingRevision,
} from "@/api/adminSettings";

export function describeValue(value: number | null, setting: RuntimeSetting) {
  return value === null
    ? `default (${setting.default_value} ${setting.unit})`
    : `${value} ${setting.unit}`;
}

// What saving the form would do. A blank draft means "return to the default".
export function reviewDraft(draft: string, setting: RuntimeSetting) {
  const next = draft.trim() === "" ? null : Number(draft);
  return {
    next,
    changed: next !== setting.override_value,
    outOfRange: next !== null && !(Number.isInteger(next) && next >= setting.min && next <= setting.max),
  };
}

function RuntimeSettingCard({
  setting,
  onSaved,
}: {
  setting: RuntimeSetting;
  onSaved: (settings: RuntimeSetting[]) => void;
}) {
  const [draft, setDraft] = useState(String(setting.override_value ?? ""));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<RuntimeSettingRevision[] | null>(null);

  const reloadRevisions = useCallback(async () => {
    try {
      setRevisions(await listRuntimeSettingRevisions(setting.key));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load change history");
    }
  }, [setting.key]);

  useEffect(() => {
    void reloadRevisions();
  }, [reloadRevisions]);

  const { next, changed, outOfRange } = reviewDraft(draft, setting);
  const canSave = changed && !outOfRange && reason.trim() !== "" && !busy;

  async function save() {
    setBusy(true);
    try {
      onSaved(await putRuntimeSetting(setting.key, { value: next, reason }));
      setReason("");
      toast.success(`${setting.label} updated`);
      await reloadRevisions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title={setting.label}
      status={`Live value: ${setting.effective_value} ${setting.unit}`}
    >
      <p className="mb-4 max-w-lg text-caption">{setting.description}</p>
      <form
        className="max-w-lg space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void save();
        }}
      >
        <Field
          label={`Value (${setting.unit})`}
          htmlFor={`runtime-${setting.key}`}
          status={`Leave blank to use the default, ${setting.default_value}. Allowed: ${setting.min}–${setting.max}.`}
          error={outOfRange ? `Enter a whole number from ${setting.min} to ${setting.max}.` : undefined}
        >
          <Input
            id={`runtime-${setting.key}`}
            type="number"
            min={setting.min}
            max={setting.max}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={String(setting.default_value)}
            disabled={busy}
          />
        </Field>

        <Field label="Reason for change" htmlFor={`runtime-${setting.key}-reason`} status="Saved with this change in the history.">
          <Textarea
            id={`runtime-${setting.key}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={busy}
          />
        </Field>

        {changed && !outOfRange && (
          <Banner severity="info">
            Changes {describeValue(setting.override_value, setting)} to {describeValue(next, setting)}.
            It applies immediately, without a restart.
          </Banner>
        )}

        <ActionButton
          action="save"
          context="settings"
          type="submit"
          accessibleLabel={`Save ${setting.label}`}
          disabled={!canSave}
          loading={busy}
        />
      </form>

      <ItemList presentationLevel="max" controlSize="regular" className="mt-4">
        {revisions === null && <OperationsItem title="Loading change history…" disabled />}
        {revisions?.length === 0 && <EmptyState icon={History} title="No changes yet" className="py-4" />}
        {revisions?.map((revision) => (
          <OperationsItem
            key={revision.id}
            title={`${revision.old_value ?? "default"} → ${revision.new_value ?? "default"}`}
            subtitle={<span title={revision.reason}>{revision.reason}</span>}
            metadata={`${revision.actor_name ?? "Deleted user"} · ${new Date(revision.created_at).toLocaleString()}`}
            actions={
              <ActionButton
                action="review"
                context="settings"
                accessibleLabel={`Review restoring ${describeValue(revision.old_value, setting)}`}
                title="Load the previous value into the form to review before saving"
                controlSize="compact"
                disabled={busy}
                onClick={() => {
                  setDraft(String(revision.old_value ?? ""));
                  setReason(`Restore value from before: ${revision.reason}`.slice(0, 500));
                }}
              />
            }
          />
        ))}
      </ItemList>
    </SettingsCard>
  );
}

// Admin-only: settings that apply without a restart. Each change shows its diff
// before saving and needs a reason, and the history can restore earlier values.
// Renders nothing for non-admins (route-level nav is also admin-gated).
export function AdminRuntimeSettings() {
  const isAdmin = useIsAdmin();
  const [settings, setSettings] = useState<RuntimeSetting[] | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    listRuntimeSettings()
      .then(setSettings)
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load runtime settings"));
  }, [isAdmin]);

  if (!isAdmin) return null;

  return (
    <SettingsSection title="Runtime settings" icon={SlidersHorizontal}>
      {settings?.map((setting) => (
        <RuntimeSettingCard key={setting.key} setting={setting} onSaved={setSettings} />
      ))}
    </SettingsSection>
  );
}
