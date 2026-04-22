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
};

export type UserSearchResult = {
  user_id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
};
