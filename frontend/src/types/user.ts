export type CurrentUser = {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
} | null;

export type Friend = {
  user_id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  friendship_id?: string;
  status?: "pending" | "accepted" | "rejected" | "blocked" | string;
  relationship_status?: "none" | "pending" | "accepted" | "rejected" | "blocked" | string;
  direction?: "incoming" | "outgoing" | "blocked_by_me" | "blocked_by_them" | string | null;
};

export type UserSearchResult = {
  user_id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  friendship_id?: string | null;
  relationship_status?: "none" | "pending" | "accepted" | "rejected" | "blocked" | string;
  direction?: "incoming" | "outgoing" | "blocked_by_me" | "blocked_by_them" | string | null;
};
