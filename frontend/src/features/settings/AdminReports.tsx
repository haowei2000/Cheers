import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { listReports, updateReport, type ContentReport } from "@/api/reports";
import { Button } from "@/components/ui/button";
import { OperationsItem } from "@/components/ui/item";

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
    <div className="space-y-4">
      <div><h2 className="text-comfortable font-semibold text-content-primary">Safety reports</h2><p className="text-regular text-content-muted">Review user and message reports. IDs remain available for audit without exposing unrelated channel content.</p></div>
      {loading && <p className="text-regular text-content-muted">Loading…</p>}
      {!loading && reports.length === 0 && <p className="text-regular text-content-muted">No reports.</p>}
      {reports.map((report) => (
        <OperationsItem key={report.report_id} presentationLevel="medium"
          title={<span title={`${report.reason} · ${report.target_type} · ${report.target_id}${report.channel_id ? ` · Channel ${report.channel_id}` : ""}${report.details ? ` · ${report.details}` : ""}`}>
            {report.reason} · {report.target_type}
          </span>}
          criticalStatus={<span className="text-compact text-content-muted">{report.status}</span>}
          actions={<>
            <Button action="review" aria-label={`Review report ${report.report_id}`} controlSize="compact" variant="secondary" onClick={() => void setStatus(report, "reviewing")} />
            <Button action="resolve" aria-label={`Resolve report ${report.report_id}`} controlSize="compact" onClick={() => void setStatus(report, "resolved")} />
            <Button action="dismiss" aria-label={`Dismiss report ${report.report_id}`} controlSize="compact" variant="secondary" onClick={() => void setStatus(report, "dismissed")} />
          </>}
          className="border-0 bg-zinc-900"
        />
      ))}
    </div>
  );
}
