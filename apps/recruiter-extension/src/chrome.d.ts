declare const chrome: {
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    connect(options: { name: string }): ChromePort;
    onConnect: { addListener(listener: (port: ChromePort) => void): void };
    onMessage: { addListener(listener: (message: unknown,
      sender: { origin?: string; url?: string },
      respond: (value: unknown) => void) => boolean | void): void };
    onMessageExternal: { addListener(listener: (message: unknown,
    sender: { origin?: string; url?: string },
    respond: (value: unknown) => void) => boolean | void): void };
  };
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void> } };
};

type ChromePort = {
  name: string;
  sender?: { origin?: string; url?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
