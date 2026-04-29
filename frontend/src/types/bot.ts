export type BotItem = {
  bot_id: string;
  username: string;
  display_name?: string;
  intro?: string;
  avatar_url?: string;
  status?: string;
  binding_type?: "http" | "websocket" | string;
  connection_status?: string;
  is_online?: boolean;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
};
