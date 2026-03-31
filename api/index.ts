export default async function handler(req: any, res: any) {
  const mod = await import("../artifacts/api-server/dist/app.mjs");
  const app = mod.default as (req: any, res: any) => unknown;
  return app(req, res);
}
