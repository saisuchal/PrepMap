export default async function handler(req: any, res: any) {
  // @ts-ignore - generated build artifact has no .d.ts on Vercel
  const mod = await import("../artifacts/api-server/dist/app.mjs");
  const app = mod.default as (req: any, res: any) => unknown;
  return app(req, res);
}
