import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { listReports, updateReport, type ContentReport } from "@/api/reports";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { SettingsCard, SettingsSection } from "@/components/ui/settings-card";
import { ShieldAlert } from "lucide-react";

export function AdminReports() {
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    try { setReports(await listReports()); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't load reports"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  async function setStatus(report: ContentReport, status: "reviewing" | "resolved" | "dismissed") {
    try {
      await updateReport(report.report_id, status);
      await reload();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't update report"); }
  }

  return (
    <SettingsSection title="Safety reports" icon={ShieldAlert}>
      <SettingsCard
        title="Reported content"
        description="Review user and message reports. IDs remain available for audit without exposing unrelated channel content."
      >
        <ItemList presentationLevel="medium" controlSize="regular">
          {loading && <OperationsItem title="Loading reports…" disabled />}
          {!loading && reports.length === 0 && <OperationsItem title="No reports" />}
          {reports.map((report) => (
          <OperationsItem key={report.report_id}
          title={<span title={`${report.reason} · ${report.target_type} · ${report.target_id}${report.channel_id ? ` · Channel ${report.channel_id}` : ""}${report.details ? ` · ${report.details}` : ""}`}>
            {report.reason} · {report.target_type}
          </span>}
          status={<Badge tone={report.status === "resolved" ? "success" : report.status === "dismissed" ? "neutral" : "warning"} indicator={report.status === "reviewing"}>{report.status}</Badge>}
          actions={<>
            <ActionButton action="review" context="settings" accessibleLabel={`Review report ${report.report_id}`} controlSize="compact" onClick={() => void setStatus(report, "reviewing")} />
            <ActionButton action="resolve" context="settings" accessibleLabel={`Resolve report ${report.report_id}`} controlSize="compact" onClick={() => void setStatus(report, "resolved")} />
            <ActionButton action="dismiss" context="settings" accessibleLabel={`Dismiss report ${report.report_id}`} controlSize="compact" onClick={() => void setStatus(report, "dismissed")} />
          </>}
        />
          ))}
        </ItemList>
      </SettingsCard>
    </SettingsSection>
  );
}
