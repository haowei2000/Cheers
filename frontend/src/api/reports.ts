import { apiJson } from "./client";

export interface ContentReport {
  report_id: string;
  reporter_id: string;
  target_type: "message" | "user";
  target_id: string;
  channel_id?: string | null;
  reason: string;
  details?: string | null;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  resolution?: string | null;
  created_at?: string | null;
}

export const listReports = () => apiJson<ContentReport[]>("/admin/reports");

export async function updateReport(
  reportId: string,
  status: "reviewing" | "resolved" | "dismissed",
  resolution?: string
): Promise<void> {
  await apiJson(`/admin/reports/${reportId}`, {
    method: "PATCH",
    body: JSON.stringify({ status, resolution }),
  });
}
