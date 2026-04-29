export type MemberItem = {
  member_id: string;
  member_type: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
};

export type ChannelMember = MemberItem & {
  template_id?: string | null;
  template_name?: string | null;
  status?: string;
  binding_type?: "http" | "websocket" | string;
  connection_status?: string;
  is_online?: boolean;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
};

export type ChannelParticipant = {
  member_id: string;
  username: string;
  avatar_url?: string;
  display_name?: string;
  status?: string;
  binding_type?: "http" | "websocket" | string;
  connection_status?: string;
  is_online?: boolean;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
};

export type ChannelBot = ChannelParticipant;
export type ChannelUser = ChannelParticipant;
