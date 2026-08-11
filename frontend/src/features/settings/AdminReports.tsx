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
      <div><h2 className="text-lg font-semibold text-zinc-100">Safety reports</h2><p className="text-sm text-zinc-400">Review user and message reports. IDs remain available for audit without exposing unrelated channel content.</p></div>
      {loading && <p className="text-sm text-zinc-400">Loading…</p>}
      {!loading && reports.length === 0 && <p className="text-sm text-zinc-400">No reports.</p>}
      {reports.map((report) => (
        <OperationsItem key={report.report_id} presentationLevel="max"
          title={`${report.reason} · ${report.target_type}`}
          subtitle={`Target: ${report.target_id}${report.channel_id ? ` · Channel: ${report.channel_id}` : ""}`}
          preview={report.details}
          criticalStatus={<span className="text-xs text-zinc-400">{report.status}</span>}
          actions={<>
            <Button size="sm" variant="secondary" onClick={() => void setStatus(report, "reviewing")}>Reviewing</Button>
            <Button size="sm" onClick={() => void setStatus(report, "resolved")}>Resolve</Button>
            <Button size="sm" variant="secondary" onClick={() => void setStatus(report, "dismissed")}>Dismiss</Button>
          </>}
          className="border-0 bg-zinc-900"
        />
      ))}
    </div>
  );
}
