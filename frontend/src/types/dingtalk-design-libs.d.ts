declare module "dingtalk-design-libs/biz/openAuth" {
  export interface DingTalkOpenAuthOptions {
    clientId: string;
    corpId: string;
    rpcScope: string;
    fieldScope?: string;
    type: 0 | 1;
  }

  export interface DingTalkOpenAuthResult {
    status: "ok" | "failed" | "cancel";
    result: {
      authCode?: string;
    } | null;
  }

  export function openAuth(options: DingTalkOpenAuthOptions): Promise<DingTalkOpenAuthResult>;
}
