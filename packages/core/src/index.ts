export * from "./contracts.ts";

export async function createBrowserSession() {
  const module = await import("./browser-session.ts");
  return module.createBrowserSession();
}
