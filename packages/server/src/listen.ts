import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import type { DashboardServer } from "./server.js";

/** The dashboard is only ever reachable from this machine. */
const LOOPBACK = "127.0.0.1";

export interface ListenOptions {
  /** Preferred port; when it is taken, the OS picks a free one. 0 always lets the OS pick. */
  port: number;
}

export interface Listening {
  url: string;
  close(): Promise<void>;
}

/** Starts serving `server` on the loopback interface. */
export async function listen(server: DashboardServer, { port }: ListenOptions): Promise<Listening> {
  const http = createAdaptorServer({ fetch: server.fetch }) as Server;
  try {
    await bind(http, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === 0) throw error;
    await bind(http, 0);
  }
  const address = http.address() as AddressInfo;
  return {
    url: `http://${LOOPBACK}:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}

function bind(http: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      http.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      http.off("error", onError);
      resolve();
    };
    http.once("error", onError);
    http.once("listening", onListening);
    http.listen(port, LOOPBACK);
  });
}
