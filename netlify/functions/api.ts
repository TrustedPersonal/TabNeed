import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_HOURS = 12;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DATA_PATH = (process.env.GITHUB_DATA_PATH || "data/tabneed.json").replace(/^\/+/, "");
const GITHUB_API = "https://api.github.com";

type Agent = {
  id: number;
  name: string;
  lastCents: number;
  totalCents: number;
  targetCents: number;
};
type Deposit = { id: number; agentId: number; amountCents: number; createdAt: string };
type Store = { version: 1; nextAgentId: number; nextDepositId: number; agents: Agent[]; deposits: Deposit[] };
type StoreSnapshot = { store: Store; sha: string | null };

const emptyStore = (): Store => ({ version: 1, nextAgentId: 1, nextDepositId: 1, agents: [], deposits: [] });
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const toCents = (value: unknown) => Math.round(Number(value) * 100);
const sign = (payload: string) => createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function createToken() {
  const payload = Buffer.from(JSON.stringify({ u: ADMIN_USERNAME, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function isAdmin(req: Request) {
  if (!SESSION_SECRET) return false;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
    return parsed.u === ADMIN_USERNAME && typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch { return false; }
}
const serializeAgent = (a: Agent) => ({ id: a.id, name: a.name, last: a.lastCents / 100, total: a.totalCents / 100, target: a.targetCents / 100 });
async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { const body = await req.json(); return body && typeof body === "object" ? body as Record<string, unknown> : {}; }
  catch { return {}; }
}
function checkGitHubConfig() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) throw new Error("GitHub storage is not configured. Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO in Netlify environment variables.");
}
function contentUrl() {
  const encodedPath = GITHUB_DATA_PATH.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_API}/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodedPath}`;
}
function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "TabNeed-Shared-Data",
  };
}
function normalizeStore(value: unknown): Store {
  if (!value || typeof value !== "object") return emptyStore();
  const raw = value as Partial<Store>;
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  const deposits = Array.isArray(raw.deposits) ? raw.deposits : [];
  const maxAgent = agents.reduce((m, a) => Math.max(m, Number(a?.id) || 0), 0);
  const maxDeposit = deposits.reduce((m, d) => Math.max(m, Number(d?.id) || 0), 0);
  return {
    version: 1,
    nextAgentId: Math.max(Number(raw.nextAgentId) || 1, maxAgent + 1),
    nextDepositId: Math.max(Number(raw.nextDepositId) || 1, maxDeposit + 1),
    agents: agents.map((a: any) => ({ id: Number(a.id), name: String(a.name || "Agent"), lastCents: Math.max(0, Number(a.lastCents) || 0), totalCents: Math.max(0, Number(a.totalCents) || 0), targetCents: Math.max(0, Number(a.targetCents) || 0) })),
    deposits: deposits.map((d: any) => ({ id: Number(d.id), agentId: Number(d.agentId), amountCents: Math.max(0, Number(d.amountCents) || 0), createdAt: String(d.createdAt || new Date().toISOString()) })),
  };
}
async function readStore(): Promise<StoreSnapshot> {
  checkGitHubConfig();
  const response = await fetch(`${contentUrl()}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: githubHeaders(), cache: "no-store" });
  if (response.status === 404) return { store: emptyStore(), sha: null };
  if (!response.ok) {
    const detail = await response.text();
    console.error("GitHub read failed", response.status, detail.slice(0, 500));
    throw new Error(response.status === 401 || response.status === 403 ? "GitHub authentication failed. Check the repository token permissions and repository settings." : `GitHub could not read the data file (HTTP ${response.status}).`);
  }
  const file = await response.json() as { content?: string; encoding?: string; sha?: string };
  if (!file.content || file.encoding !== "base64" || !file.sha) throw new Error("GitHub data file has an unsupported format.");
  try {
    const decoded = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    return { store: normalizeStore(JSON.parse(decoded)), sha: file.sha };
  } catch {
    throw new Error("The GitHub data file contains invalid JSON. Fix or restore data/tabneed.json.");
  }
}
async function writeStore(store: Store, sha: string | null) {
  const response = await fetch(contentUrl(), {
    method: "PUT",
    headers: githubHeaders(),
    body: JSON.stringify({
      message: `TabNeed data update (${new Date().toISOString()})`,
      content: Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8").toString("base64"),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (response.status === 409 || response.status === 422) return false; // another device updated the file; retry against the newest SHA
  if (!response.ok) {
    const detail = await response.text();
    console.error("GitHub write failed", response.status, detail.slice(0, 500));
    throw new Error(response.status === 401 || response.status === 403 ? "GitHub cannot write the data file. Check that the token has Contents: Read and write permission." : `GitHub could not save the data file (HTTP ${response.status}).`);
  }
  return true;
}
async function updateStore<T>(mutate: (store: Store) => T): Promise<{ store: Store; result: T }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = await readStore();
    const draft = structuredClone(snapshot.store);
    const result = mutate(draft);
    if (await writeStore(draft, snapshot.sha)) return { store: draft, result };
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw new Error("The data changed repeatedly while saving. Please try again.");
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method;
  try {
    if (route === "board" && method === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      const { store } = await readStore();
      const latestDepositId = store.deposits.reduce((m, d) => Math.max(m, d.id), 0);
      const agentNames = new Map(store.agents.map(a => [a.id, a.name]));
      const fresh = after > 0 ? store.deposits.filter(d => d.id > after).sort((a, b) => a.id - b.id).slice(0, 20) : [];
      return json({
        agents: store.agents.slice().sort((a, b) => a.id - b.id).map(serializeAgent),
        latestDepositId,
        newDeposits: fresh.map(d => ({ id: d.id, amount: d.amountCents / 100, agentName: agentNames.get(d.agentId) || "Agent" })),
      });
    }
    if (route === "login" && method === "POST") {
      if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) return fail("Admin login is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET in Netlify environment variables.", 500);
      const { username, password } = await readBody(req);
      const ok = safeEqual(String(username ?? "").trim(), ADMIN_USERNAME) && safeEqual(String(password ?? ""), ADMIN_PASSWORD);
      if (!ok) return fail("Incorrect username or password.", 401);
      return json({ token: createToken() });
    }
    if (!isAdmin(req)) return fail("Admin session expired. Please log in again.", 401);

    if (route === "agents" && method === "POST") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim().slice(0, 80);
      const target = Number(body.target);
      if (!name) return fail("Enter an agent name");
      if (!Number.isFinite(target) || target < 0) return fail("Enter a valid target");
      const { result: agent } = await updateStore(store => {
        const created: Agent = { id: store.nextAgentId++, name, lastCents: 0, totalCents: 0, targetCents: toCents(target) };
        store.agents.push(created);
        return created;
      });
      return json(serializeAgent(agent), 201);
    }
    const agentMatch = route.match(/^agents\/(\d+)$/);
    if (agentMatch && method === "DELETE") {
      const id = Number(agentMatch[1]);
      const { result: removed } = await updateStore(store => {
        const index = store.agents.findIndex(a => a.id === id);
        if (index < 0) return false;
        store.agents.splice(index, 1);
        store.deposits = store.deposits.filter(d => d.agentId !== id);
        return true;
      });
      if (!removed) return fail("Agent not found", 404);
      return json({ ok: true });
    }
    if (route === "deposits" && method === "POST") {
      const body = await readBody(req);
      const agentId = Number(body.agentId);
      const amountCents = toCents(body.amount);
      if (!Number.isInteger(agentId) || agentId <= 0) return fail("Add an agent first");
      if (!Number.isFinite(amountCents) || amountCents <= 0) return fail("Enter a valid deposit amount");
      const { result } = await updateStore(store => {
        const agent = store.agents.find(a => a.id === agentId);
        if (!agent) return null;
        agent.lastCents = amountCents;
        agent.totalCents += amountCents;
        const deposit: Deposit = { id: store.nextDepositId++, agentId, amountCents, createdAt: new Date().toISOString() };
        store.deposits.push(deposit);
        return { agent: serializeAgent(agent), deposit: { id: deposit.id, amount: amountCents / 100, agentName: agent.name } };
      });
      if (!result) return fail("Agent not found", 404);
      return json(result, 201);
    }
    if (route === "import" && method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.agents)) return fail("Invalid data");
      const rows = body.agents.map((a: Record<string, unknown>) => ({
        name: String(a?.name ?? "Agent").trim().slice(0, 80) || "Agent",
        lastCents: Math.max(0, toCents(a?.last ?? 0) || 0),
        totalCents: Math.max(0, toCents(a?.total ?? 0) || 0),
        targetCents: Math.max(0, toCents(a?.target ?? 0) || 0),
      }));
      const { result: count } = await updateStore(store => {
        store.agents = rows.map(row => ({ id: store.nextAgentId++, ...row }));
        store.deposits = [];
        return store.agents.length;
      });
      return json({ ok: true, count });
    }
    if (route === "data" && method === "DELETE") {
      await updateStore(store => { store.agents = []; store.deposits = []; store.nextAgentId = 1; store.nextDepositId = 1; return true; });
      return json({ ok: true });
    }
    return fail("Not found", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server error. Please try again.";
    console.error("API error", error);
    return fail(message, 500);
  }
};

export const config: Config = { path: "/api/*" };
