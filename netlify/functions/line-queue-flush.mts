import type { Config } from "@netlify/functions";
import { flushLineQueue } from "../lib/line-queue.mts";

// お客様へのLINEのお知らせのうち、まとめて送る予定（夜→朝10時、昼の30分まとめ）になっている分を送る。
// 定期実行の関数は、Netlify が本番デプロイに対してのみ実行する。
export default async () => {
  await flushLineQueue().catch(() => {});
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
