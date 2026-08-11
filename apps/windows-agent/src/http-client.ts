export class AgentHttpClient {
  constructor(private readonly origin: string) {}

  post<T>(path: string, body: unknown) {
    return request<T>(new URL(`/api/v1/${path}`, this.origin), body);
  }
}

async function request<T>(url: URL, body: unknown) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Authenti8 request failed (${response.status}).`);
  return response.json() as Promise<T>;
}
