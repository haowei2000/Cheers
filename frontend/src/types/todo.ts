export type TodoItem = {
  todo_id: string;
  channel_id: string;
  creator_id: string;
  creator_type: string;
  assignee_id: string | null;
  assignee_type: string | null;
  content: string;
  status: string;
  created_at?: string;
  updated_at?: string;
};
