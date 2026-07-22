import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { listReports, updateReport, type ContentReport } from "@/api/reports";
import { Button } from "@/components/ui/button";

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
        <div key={report.report_id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-2">
          <div className="flex justify-between gap-3"><span className="font-medium text-zinc-100">{report.reason} · {report.target_type}</span><span className="text-xs text-zinc-400">{report.status}</span></div>
          <p className="text-xs font-mono text-zinc-400 break-all">Target: {report.target_id}{report.channel_id ? ` · Channel: ${report.channel_id}` : ""}</p>
          {report.details && <p className="text-sm text-zinc-300">{report.details}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void setStatus(report, "reviewing")}>Reviewing</Button>
            <Button size="sm" onClick={() => void setStatus(report, "resolved")}>Resolve</Button>
            <Button size="sm" variant="secondary" onClick={() => void setStatus(report, "dismissed")}>Dismiss</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
