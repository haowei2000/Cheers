import { BotListSubPane } from "./BotListSubPane";
import type { BotRow } from "./types";

export type { BotRow } from "./types";

export function BotPane({
  bots,
  authToken,
  onChanged,
}: {
  bots: BotRow[];
  authToken: string | null;
  onChanged: () => void;
}) {
  return <BotListSubPane bots={bots} authToken={authToken} onChanged={onChanged} />;
}
