import { apiJson } from "./client";

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user_id: string;
  display_name: string | null;
}

export async function login(credentials: {
  login: string;
  password: string;
}): Promise<LoginResponse> {
  return apiJson<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}
