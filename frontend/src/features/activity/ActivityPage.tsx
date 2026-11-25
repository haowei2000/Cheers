import { Bell } from "lucide-react";
import { PageLayout } from "@/components/ui/page-layout";
import { ActivityInbox } from "./ActivityInbox";

export default function ActivityPage() {
  return <PageLayout title="Activity" icon={Bell} description="Approvals, invitations, and audit log">
    <ActivityInbox />
  </PageLayout>;
}
