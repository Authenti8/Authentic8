export class AgentHttpClient {
  constructor(private readonly origin: string) {}

  async post<T>(path: string, body: unknown) {
    const response = await fetch(new URL(`/api/v1/${path}`, this.origin), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Authenti8 request failed (${response.status}).`);
    return response.json() as Promise<T>;
  }
}
