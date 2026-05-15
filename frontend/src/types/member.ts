export type MemberItem = {
  member_id: string;
  member_type: string;
  role?: "owner" | "admin" | "member" | string;
  added_by?: string | null;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  status?: string;
  is_online?: boolean;
};

export type ChannelMember = MemberItem & {
  template_id?: string | null;
  template_name?: string | null;
  can_manage_template?: boolean;
  status?: string;
  scope?: "private" | "friend" | "everyone";
  owner?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
  inviter?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
  binding_type?: "http" | "agent_bridge" | string;
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
  scope?: "private" | "friend" | "everyone";
  owner?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
  binding_type?: "http" | "agent_bridge" | string;
  connection_status?: string;
  is_online?: boolean;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
};

export type ChannelBot = ChannelParticipant;
export type ChannelUser = ChannelParticipant;
