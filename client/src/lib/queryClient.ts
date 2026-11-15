import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
let csrf = "";
export const setCsrf = (value: string) => { csrf = value; };

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.headers.get("X-Relay-Login") === "required") {
      csrf = "";
      window.dispatchEvent(new Event("relay-signed-out"));
    }
    const text = (await res.text()) || res.statusText;
    let message = text;
    try { message = JSON.parse(text).message || text; } catch {}
    throw new Error(message);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    credentials: "same-origin",
    headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-Relay-CSRF": csrf } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
